"""Hugging Face Spaces — Free Whisper Transcription Microservice.

Deployable on Hugging Face Spaces Free 16 GB RAM CPU tier.
Provides a REST API for MediGraph and an interactive Gradio test interface.
"""
import os
import tempfile
import gradio as gr
from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel

# Available models on Hugging Face CPU tier (16GB RAM)
AVAILABLE_MODELS = {
    "whisper-base": "base",
    "whisper-small": "small",
    "whisper-medium": "medium",
}

DEFAULT_MODEL = os.getenv("WHISPER_MODEL", "small")
print(f"Loading faster-whisper model: {DEFAULT_MODEL} on CPU (INT8)...")
# int8 compute type runs ultra-fast and lightweight on CPU
whisper_model = WhisperModel(DEFAULT_MODEL, device="cpu", compute_type="int8")


def transcribe_audio_file(audio_path: str, model_name: str = DEFAULT_MODEL) -> str:
    """Run transcription using faster-whisper."""
    global whisper_model, DEFAULT_MODEL
    if model_name != DEFAULT_MODEL and model_name in AVAILABLE_MODELS:
        whisper_model = WhisperModel(AVAILABLE_MODELS[model_name], device="cpu", compute_type="int8")
        DEFAULT_MODEL = model_name

    segments, info = whisper_model.transcribe(audio_path, beam_size=5, language="en")
    transcript = " ".join([segment.text for segment in segments]).strip()
    return transcript


# FastAPI backend for MediGraph API requests
app = FastAPI(title="MediGraph Free Whisper Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/transcribe")
async def api_transcribe(
    file: UploadFile = File(...),
    model: str = Form("small"),
):
    """REST endpoint called by MediGraph backend."""
    suffix = os.path.splitext(file.filename or "")[1] or ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    try:
        text = transcribe_audio_file(tmp_path, model_name=model)
        return {"transcript": text, "model": model, "status": "ok"}
    except Exception as e:
        return {"error": str(e), "status": "error"}
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


@app.get("/health")
def api_health():
    return {"status": "ok", "service": "MediGraph Whisper Space", "model": DEFAULT_MODEL}


# Gradio interactive UI mounted at the root
demo = gr.Interface(
    fn=transcribe_audio_file,
    inputs=[
        gr.Audio(type="filepath", label="Upload Clinical Audio / Dictation"),
        gr.Dropdown(choices=["whisper-base", "whisper-small", "whisper-medium"], value="whisper-small", label="Whisper Model"),
    ],
    outputs=gr.Textbox(label="Transcribed Clinical Text", lines=8),
    title="MediGraph — Free Medical Whisper Transcription Space",
    description="Running on Hugging Face Free 16 GB RAM CPU Instance with faster-whisper INT8.",
)

# Mount Gradio onto FastAPI
app = gr.mount_gradio_app(app, demo, path="/")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=7860)
