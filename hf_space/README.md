---
title: MediGraph Whisper Service
emoji: 🩺
colorFrom: blue
colorTo: green
sdk: gradio
sdk_version: 5.20.0
app_file: app.py
pinned: false
---

# MediGraph Free Whisper Service on Hugging Face Spaces (Gradio SDK)

This Space provides a free 16 GB RAM transcription microservice running `faster-whisper` (INT8 quantized) for the MediGraph clinical platform.

## 1-Click Deployment to Hugging Face Spaces (Gradio)
1. Go to [huggingface.co/spaces](https://huggingface.co/spaces) and click **"Create new Space"**.
2. Set Space Name: e.g. `medigraph-whisper`.
3. Select **Gradio** as the Space SDK (No Docker required).
4. Select the **CPU basic · 2 vCPU · 16 GB RAM · FREE** hardware tier.
5. Set visibility to **Public**.
6. Upload the 3 files from this folder:
   - `app.py`
   - `requirements.txt`
   - `README.md`
7. Once running, your space endpoint is:
   `https://<your-username>-medigraph-whisper.hf.space`
8. In your MediGraph `.env` file, add:
   ```env
   HF_WHISPER_ENDPOINT=https://<your-username>-medigraph-whisper.hf.space
   ```
   Or paste this URL directly in the MediGraph Scribe Studio UI under **HF Space**.
