"""Hugging Face Spaces — Free Whisper Transcription Microservice (Gradio SDK).

Deployable on Hugging Face Spaces Free 16 GB RAM CPU tier using Gradio SDK (No Docker required).
Provides an interactive web interface AND a direct REST API for MediGraph.
"""
import os
import tempfile
import gradio as gr
from fastapi import UploadFile, File, Form
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


def transcribe_audio_file(audio_path: str, model_name: str = "whisper-small") -> str:
    """Run transcription using faster-whisper."""
    global whisper_model, DEFAULT_MODEL
    if not audio_path:
        return ""

    internal_name = AVAILABLE_MODELS.get(model_name, model_name)
    if internal_name != DEFAULT_MODEL:
        print(f"Switching model to {internal_name}...")
        whisper_model = WhisperModel(internal_name, device="cpu", compute_type="int8")
        DEFAULT_MODEL = internal_name

    segments, info = whisper_model.transcribe(audio_path, beam_size=5, language="en")
    transcript = " ".join([segment.text for segment in segments]).strip()
    return transcript


# --- Gradio Web UI ---
with gr.Blocks(title="MediGraph Whisper Space") as demo:
    gr.Markdown(
        """
        # 🩺 MediGraph — Free Whisper Clinical Transcription Space
        Running on **Hugging Face Free 16 GB RAM CPU Instance** with `faster-whisper` (INT8 Quantized).
        """
    )
    with gr.Row():
        with gr.Column():
            audio_input = gr.Audio(type="filepath", label="Upload or Record Consultation Audio")
            model_selector = gr.Dropdown(
                choices=["whisper-base", "whisper-small", "whisper-medium"],
                value="whisper-small",
                label="Whisper Model Selection",
            )
            transcribe_btn = gr.Button("Transcribe Clinical Audio", variant="primary")
        with gr.Column():
            output_text = gr.Textbox(label="Transcribed Clinical Transcript", lines=10)

    transcribe_btn.click(
        fn=transcribe_audio_file,
        inputs=[audio_input, model_selector],
        outputs=output_text,
        api_name="transcribe",
    )


# --- REST API Endpoints for MediGraph Integration ---
# Gradio 4+ and 5+ expose `demo.app` as a FastAPI application
@demo.app.post("/transcribe")
async def api_transcribe(
    file: UploadFile = File(...),
    model: str = Form("whisper-small"),
):
    """REST endpoint called by MediGraph backend."""
    suffix = os.path.splitext(file.filename or "")[1] or ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        text = transcribe_audio_file(tmp_path, model_name=model)
        return {"transcript": text, "model": model, "status": "ok"}
    except Exception as e:
        return {"error": str(e), "status": "error"}
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


@demo.app.get("/health")
def api_health():
    """Health check endpoint for MediGraph."""
    return {"status": "ok", "service": "MediGraph Whisper Space", "model": DEFAULT_MODEL}


if __name__ == "__main__":
    demo.launch(server_name="0.0.0.0", server_port=7860)
