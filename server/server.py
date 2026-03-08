"""
Pocket Reader TTS Server

A Flask server that uses Pocket TTS to convert text to speech.
Supports streaming audio and multiple voices.
"""

import io
import re
import wave
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
    print("  POST /preload     - Preload model and voices")
    print("\nServer running at http://localhost:5050")
    
    # Preload the model on startup
    get_model()
    get_voice_state('alba')
    
    app.run(host='0.0.0.0', port=5050)


if __name__ == '__main__':
    main()
