"""
Pocket Reader TTS Server

A Flask server that uses Pocket TTS to convert text to speech.
Supports streaming audio and multiple voices.
"""

import io
import json
import re
import wave
import base64
from flask import Flask, request, jsonify, Response
from flask_cors import CORS
import numpy as np

app = Flask(__name__)
CORS(app)  # Enable CORS for Chrome extension

# Global model instance (lazy loaded)
_tts_model = None
_voice_states = {}

# Available voices (these are the predefined catalog voices)
AVAILABLE_VOICES = ["alba", "marius", "javert", "jean", "fantine", "cosette", "eponine", "azelma"]


SMART_QUOTE_MAP = str.maketrans({
    "\u201c": '"',
    "\u201d": '"',
    "\u2018": "'",
    "\u2019": "'",
    "\u201e": '"',
    "\u201f": '"',
    "\u2032": "'",
    "\u2033": '"',
})


def get_model():
    """Lazy load the TTS model."""
    global _tts_model
    if _tts_model is None:
        from pocket_tts import TTSModel
        print("Loading Pocket TTS model...")
        _tts_model = TTSModel.load_model()
        print("Model loaded successfully!")
    return _tts_model


def get_voice_state(voice_name: str):
    """Get or create a voice state for the given voice."""
    global _voice_states
    if voice_name not in _voice_states:
        model = get_model()
        # Use the voice name directly - pocket_tts handles the predefined voices
        print(f"Loading voice: {voice_name}...")
        _voice_states[voice_name] = model.get_state_for_audio_prompt(voice_name)
        print(f"Voice {voice_name} loaded!")
    return _voice_states[voice_name]


def split_into_paragraphs(text: str) -> list[str]:
    """Split text into paragraphs for chunked processing."""
    # Split on double newlines, or single newlines followed by whitespace patterns
    paragraphs = re.split(r'\n\s*\n|\n(?=\s*[A-Z])', text)
    
    # Clean up and filter empty paragraphs
    result = []
    for p in paragraphs:
        p = p.strip()
        if p and len(p) > 10:  # Skip very short fragments
            result.append(p)
    
    # If no paragraphs found, split by sentences for very long text
    if len(result) <= 1 and len(text) > 500:
        # Split into chunks of roughly 2-3 sentences
        sentences = re.split(r'(?<=[.!?])\s+', text)
        result = []
        current_chunk = []
        current_length = 0
        
        for sentence in sentences:
            current_chunk.append(sentence)
            current_length += len(sentence)
            
            # Aim for chunks of ~300-500 characters
            if current_length >= 300:
                result.append(' '.join(current_chunk))
                current_chunk = []
                current_length = 0
        
        # Don't forget the last chunk
        if current_chunk:
            result.append(' '.join(current_chunk))
    
    return result if result else [text]


def normalize_smart_quotes(text: str) -> str:
    """Replace smart quotes with straight quotes."""
    return text.translate(SMART_QUOTE_MAP)


def audio_to_wav_bytes(audio_tensor, sample_rate: int) -> bytes:
    """Convert audio tensor to WAV bytes."""
    audio_np = audio_tensor.numpy()
    # Normalize to int16
    audio_int16 = (audio_np * 32767).astype(np.int16)
    
    # Create WAV file in memory
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)  # 16-bit
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(audio_int16.tobytes())
    
    buffer.seek(0)
    return buffer.read()


def concatenate_wav_bytes(wav_chunks: list[bytes], silence_duration: float = 0.3) -> bytes:
    """Concatenate multiple WAV byte buffers into a single WAV with silence gaps."""
    if not wav_chunks:
        raise ValueError("No audio chunks to concatenate")

    all_frames = []
    sample_rate = None
    sample_width = None
    n_channels = None

    silence_added = False
    for chunk in wav_chunks:
        buffer = io.BytesIO(chunk)
        with wave.open(buffer, 'rb') as wf:
            if sample_rate is None:
                sample_rate = wf.getframerate()
                sample_width = wf.getsampwidth()
                n_channels = wf.getnchannels()
            frames = wf.readframes(wf.getnframes())
            all_frames.append(frames)

        if not silence_added and len(wav_chunks) > 1:
            silence_samples = int(sample_rate * silence_duration)
            silence_frames = b'\x00' * (silence_samples * sample_width * n_channels)
            all_frames.append(silence_frames)
            silence_added = True

    out_buffer = io.BytesIO()
    with wave.open(out_buffer, 'wb') as out_wf:
        out_wf.setnchannels(n_channels)
        out_wf.setsampwidth(sample_width)
        out_wf.setframerate(sample_rate)
        out_wf.writeframes(b''.join(all_frames))

    out_buffer.seek(0)
    return out_buffer.read()


def split_for_streaming(text: str, max_chars: int = 320) -> list[str]:
    """Split text into speech-friendly chunks for streaming delivery."""
    paragraphs = split_into_paragraphs(text)
    chunks = []

    for paragraph in paragraphs:
        if len(paragraph) <= max_chars:
            chunks.append(paragraph)
            continue

        sentences = re.split(r'(?<=[.!?])\s+', paragraph)
        current = []
        current_len = 0

        for sentence in sentences:
            sentence = sentence.strip()
            if not sentence:
                continue

            sentence_len = len(sentence)
            if current and current_len + sentence_len + 1 > max_chars:
                chunks.append(" ".join(current))
                current = [sentence]
                current_len = sentence_len
            else:
                current.append(sentence)
                current_len += sentence_len + (1 if current_len else 0)

        if current:
            chunks.append(" ".join(current))

    return chunks if chunks else [text]


@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint."""
    return jsonify({"status": "ok"})


@app.route('/voices', methods=['GET'])
def list_voices():
    """List available voices."""
    return jsonify({
        "voices": AVAILABLE_VOICES,
        "default": "alba"
    })


@app.route('/paragraphs', methods=['POST'])
def get_paragraphs():
    """
    Split text into paragraphs for chunked TTS processing.
    
    Request body:
    {
        "text": "Full text to split"
    }
    
    Returns:
    {
        "paragraphs": ["paragraph 1", "paragraph 2", ...],
        "count": 2
    }
    """
    data = request.get_json()
    
    if not data or 'text' not in data:
        return jsonify({"error": "Missing 'text' field"}), 400
    
    text = data['text']
    if not text.strip():
        return jsonify({"error": "Text cannot be empty"}), 400
    
    text = normalize_smart_quotes(text)
    paragraphs = split_into_paragraphs(text)
    
    return jsonify({
        "paragraphs": paragraphs,
        "count": len(paragraphs)
    })


@app.route('/synthesize', methods=['POST'])
def synthesize():
    """
    Synthesize text to speech.
    
    Request body:
    {
        "text": "Text to synthesize",
        "voice": "alba"  # optional, defaults to "alba"
    }
    
    Returns: WAV audio file
    """
    data = request.get_json()
    
    if not data or 'text' not in data:
        return jsonify({"error": "Missing 'text' field"}), 400
    
    text = data['text']
    voice = data.get('voice', 'alba')
    
    if not text.strip():
        return jsonify({"error": "Text cannot be empty"}), 400

    text = normalize_smart_quotes(text)
    
    if voice not in AVAILABLE_VOICES:
        voice = 'alba'
    
    try:
        model = get_model()
        voice_state = get_voice_state(voice)
        
        print(f"Generating speech for: {text[:50]}...")
        audio = model.generate_audio(voice_state, text)
        
        wav_bytes = audio_to_wav_bytes(audio, model.sample_rate)
        
        return Response(
            wav_bytes,
            mimetype='audio/wav',
            headers={
                'Content-Disposition': 'attachment; filename=speech.wav'
            }
        )
    except Exception as e:
        print(f"Error generating speech: {e}")
        return jsonify({"error": str(e)}), 500


@app.route('/synthesize-stream', methods=['POST'])
def synthesize_stream():
    """
    Stream synthesized text as newline-delimited JSON chunks.

    Request body:
    {
        "text": "Text to synthesize",
        "voice": "alba"  # optional, defaults to "alba"
    }

    Response stream (application/x-ndjson):
    {"type":"chunk","index":0,"audio":"<base64 wav bytes>"}
    {"type":"done","count":1}
    """
    data = request.get_json()

    if not data or 'text' not in data:
        return jsonify({"error": "Missing 'text' field"}), 400

    text = data['text']
    voice = data.get('voice', 'alba')

    if not text.strip():
        return jsonify({"error": "Text cannot be empty"}), 400

    text = normalize_smart_quotes(text)

    if voice not in AVAILABLE_VOICES:
        voice = 'alba'

    def generate_stream():
        try:
            model = get_model()
            voice_state = get_voice_state(voice)
            chunks = split_for_streaming(text)

            for index, chunk in enumerate(chunks):
                audio = model.generate_audio(voice_state, chunk)
                wav_bytes = audio_to_wav_bytes(audio, model.sample_rate)
                payload = {
                    "type": "chunk",
                    "index": index,
                    "audio": base64.b64encode(wav_bytes).decode('ascii')
                }
                yield json.dumps(payload) + "\n"

            yield json.dumps({"type": "done", "count": len(chunks)}) + "\n"
        except Exception as e:
            print(f"Error streaming speech: {e}")
            yield json.dumps({"type": "error", "error": str(e)}) + "\n"

    return Response(generate_stream(), mimetype='application/x-ndjson')


@app.route('/synthesize-full', methods=['POST'])
def synthesize_full():
    """
    Synthesize full text into a single WAV by concatenating paragraph audio.

    Request body:
    {
        "text": "Full text to synthesize",
        "voice": "alba"  # optional, defaults to "alba"
    }

    Returns: Single WAV audio file with all paragraphs concatenated.
    """
    data = request.get_json()

    if not data or 'text' not in data:
        return jsonify({"error": "Missing 'text' field"}), 400

    text = data['text']
    voice = data.get('voice', 'alba')

    if not text.strip():
        return jsonify({"error": "Text cannot be empty"}), 400

    text = normalize_smart_quotes(text)

    if voice not in AVAILABLE_VOICES:
        voice = 'alba'

    try:
        model = get_model()
        voice_state = get_voice_state(voice)
        paragraphs = split_into_paragraphs(text)

        print(f"Synthesizing full audio: {len(paragraphs)} paragraphs")

        wav_chunks = []
        for i, para in enumerate(paragraphs):
            print(f"  Generating paragraph {i + 1}/{len(paragraphs)}: {para[:50]}...")
            audio = model.generate_audio(voice_state, para)
            wav_bytes = audio_to_wav_bytes(audio, model.sample_rate)
            wav_chunks.append(wav_bytes)

        full_wav = concatenate_wav_bytes(wav_chunks)

        print(f"Full audio generated: {len(full_wav)} bytes")

        return Response(
            full_wav,
            mimetype='audio/wav',
            headers={
                'Content-Disposition': 'attachment; filename=speech.wav'
            }
        )
    except Exception as e:
        print(f"Error generating full speech: {e}")
        return jsonify({"error": str(e)}), 500


@app.route('/preload', methods=['POST'])
def preload():
    """
    Preload model and voices for faster first synthesis.
    
    Request body:
    {
        "voices": ["alba", "jean"]  # optional, list of voices to preload
    }
    """
    data = request.get_json() or {}
    voices_to_load = data.get('voices', ['alba'])
    
    try:
        # Load model
        get_model()
        
        # Load specified voices
        for voice in voices_to_load:
            if voice in AVAILABLE_VOICES:
                get_voice_state(voice)
        
        return jsonify({
            "status": "ok",
            "loaded_voices": [v for v in voices_to_load if v in AVAILABLE_VOICES]
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def main():
    """Main entry point for the server."""
    print("Starting Pocket Reader TTS Server...")
    print("Available voices:", AVAILABLE_VOICES)
    print("\nEndpoints:")
    print("  GET  /health      - Health check")
    print("  GET  /voices      - List available voices")
    print("  POST /paragraphs  - Split text into paragraphs")
    print("  POST /synthesize  - Convert text to speech")
    print("  POST /synthesize-stream - Stream text as chunked speech")
    print("  POST /synthesize-full   - Synthesize full text as single WAV")
    print("  POST /preload     - Preload model and voices")
    print("\nServer running at http://localhost:5050")
    
    # Preload the model on startup
    get_model()
    get_voice_state('alba')
    
    app.run(host='0.0.0.0', port=5050)


if __name__ == '__main__':
    main()
