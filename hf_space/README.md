---
title: MediGraph Whisper Service
emoji: 🩺
colorFrom: blue
colorTo: green
sdk: gradio
sdk_version: 4.20.0
app_file: app.py
pinned: false
---

# MediGraph Free Whisper Service on Hugging Face Spaces

This Space provides a free 16 GB RAM transcription microservice running `faster-whisper` (INT8 quantized) for the MediGraph clinical platform.

## 1-Click Deployment to Hugging Face Spaces
1. Create a free account on [huggingface.co](https://huggingface.co).
2. Click **"New Space"** $\to$ choose **Gradio** SDK $\to$ select the **Free CPU (2 vCPU · 16 GB RAM)** hardware.
3. Upload `app.py`, `requirements.txt`, and this `README.md`.
4. Your Space will build and launch at `https://<your-username>-<space-name>.hf.space`.
5. In your MediGraph `.env` file, set:
   ```env
   HF_WHISPER_ENDPOINT=https://<your-username>-<space-name>.hf.space/transcribe
   ```
