import os
import requests
from dotenv import load_dotenv

load_dotenv()

_TRANSLATION_MODEL = "openai/gpt-oss-120b"
_GROQ_WHISPER_MODEL = "whisper-large-v3-turbo"


class TranscriptionError(Exception):
    """Raised when audio transcription or translation fails."""


def transcribe_groq(audio_file_path: str) -> str:
    """Transcribe an audio file using Groq's high-speed Whisper Large v3 Turbo free tier."""
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        raise TranscriptionError("GROQ_API_KEY is not configured in .env.")

    if not os.path.exists(audio_file_path):
        raise TranscriptionError(f"Audio file not found: {audio_file_path}")

    filename = os.path.basename(audio_file_path)
    # Determine basic mime type
    suffix = os.path.splitext(filename)[1].lower()
    mime_map = {
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".webm": "audio/webm",
        ".m4a": "audio/mp4",
        ".ogg": "audio/ogg",
        ".flac": "audio/flac",
    }
    content_type = mime_map.get(suffix, "audio/wav")

    try:
        with open(audio_file_path, "rb") as f:
            files = {"file": (filename, f, content_type)}
            data = {
                "model": _GROQ_WHISPER_MODEL,
                "temperature": "0",
                "response_format": "json",
            }
            resp = requests.post(
                "https://api.groq.com/openai/v1/audio/transcriptions",
                headers={"Authorization": f"Bearer {api_key}"},
                files=files,
                data=data,
                timeout=45,
            )

        if resp.status_code != 200:
            raise TranscriptionError(f"Groq Whisper transcription failed ({resp.status_code}): {resp.text}")

        result = resp.json()
        text = (result.get("text") or "").strip()
        return text
    except Exception as e:
        if isinstance(e, TranscriptionError):
            raise
        raise TranscriptionError(f"Groq Whisper error: {e}")


def transcribe_hf_space(audio_file_path: str, endpoint: str | None = None) -> str:
    """Transcribe an audio file using a Hugging Face Space running faster-whisper."""
    hf_url = endpoint or os.environ.get("HF_WHISPER_ENDPOINT")
    if not hf_url:
        raise TranscriptionError(
            "HF_WHISPER_ENDPOINT is not configured in .env. "
            "Please deploy the hf_space/ app to Hugging Face Spaces or use Groq Whisper."
        )

    # Ensure /transcribe endpoint path
    if not hf_url.rstrip("/").endswith("/transcribe"):
        hf_url = hf_url.rstrip("/") + "/transcribe"

    filename = os.path.basename(audio_file_path)
    try:
        with open(audio_file_path, "rb") as f:
            files = {"file": (filename, f, "audio/wav")}
            resp = requests.post(hf_url, files=files, timeout=60)

        if resp.status_code != 200:
            raise TranscriptionError(f"Hugging Face Space returned status {resp.status_code}: {resp.text}")

        data = resp.json()
        text = (data.get("transcript") or "").strip()
        return text
    except Exception as e:
        if isinstance(e, TranscriptionError):
            raise
        raise TranscriptionError(f"Hugging Face Space transcription error: {e}")


_LOCAL_MODEL_INSTANCE = None
_LOCAL_MODEL_NAME = None


def transcribe_local(audio_file_path: str, model_size: str = "base") -> str:
    """Transcribe locally on device using faster-whisper (INT8 CPU).

    Zero cloud dependencies, zero external network requests, 100% private.
    """
    global _LOCAL_MODEL_INSTANCE, _LOCAL_MODEL_NAME
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        raise TranscriptionError(
            "Local Whisper requires 'faster-whisper'. "
            "Please install it locally by running: pip install faster-whisper"
        )

    clean_size = model_size.lower().replace("whisper-", "").strip() or "base"
    if _LOCAL_MODEL_INSTANCE is None or _LOCAL_MODEL_NAME != clean_size:
        try:
            _LOCAL_MODEL_INSTANCE = WhisperModel(clean_size, device="cpu", compute_type="int8")
            _LOCAL_MODEL_NAME = clean_size
        except Exception as e:
            raise TranscriptionError(f"Failed to load local Whisper model '{clean_size}': {e}")

    try:
        segments, info = _LOCAL_MODEL_INSTANCE.transcribe(audio_file_path, beam_size=5, language="en")
        text = " ".join([segment.text for segment in segments]).strip()
        return text
    except Exception as e:
        if isinstance(e, TranscriptionError):
            raise
        raise TranscriptionError(f"Local Whisper transcription error: {e}")


def transcribe(
    audio_file_path: str,
    provider: str = "groq",
    model_size: str = "base",
    hf_endpoint: str | None = None,
) -> str:
    """Transcribe an audio file using the selected provider ('groq', 'local', or 'hf_space')."""
    clean_provider = provider.lower().strip()
    if clean_provider in ("local", "on_device", "offline"):
        return transcribe_local(audio_file_path, model_size=model_size)
    if clean_provider == "hf_space":
        return transcribe_hf_space(audio_file_path, endpoint=hf_endpoint)
    return transcribe_groq(audio_file_path)


def translate_text(text, target_lang="English"):
    """Translate clinical speech/transcript into target language (default English)."""
    if not text or not text.strip():
        return ""

    api_key = os.environ.get("GROQ_API_KEY_EXTRACTION") or os.environ.get("GROQ_API_KEY")
    if not api_key:
        return text

    try:
        resp = requests.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": _TRANSLATION_MODEL,
                "temperature": 0,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            f"You are a real-time clinical medical translator. Translate the patient or doctor's "
                            f"consultation speech into clear, professional {target_lang}. "
                            f"Preserve medical facts, symptoms, and numbers accurately. "
                            f"Return ONLY the direct {target_lang} translation, with no explanation or introductory text."
                        ),
                    },
                    {"role": "user", "content": text},
                ],
            },
            timeout=15,
        )
        if resp.status_code == 200:
            content = resp.json()["choices"][0]["message"]["content"]
            return content.strip()
        return text
    except Exception:
        return text

