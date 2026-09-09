import os
import requests
from dotenv import load_dotenv

load_dotenv()

_TRANSLATION_MODEL = "openai/gpt-oss-120b"


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