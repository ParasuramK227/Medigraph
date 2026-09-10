import os
import sys
import time
import urllib.request

MODELS = {
    'medium': {
        'dir': 'frontend/public/models/moonshine',
        'files': [
            ('adapter.ort', 'https://download.moonshine.ai/model/medium-streaming-en/quantized_26_07_30/adapter.ort', 3651296),
            ('cross_kv.ort', 'https://download.moonshine.ai/model/medium-streaming-en/quantized_26_07_30/cross_kv.ort', 11643776),
            ('decoder_kv.ort', 'https://download.moonshine.ai/model/medium-streaming-en/quantized_26_07_30/decoder_kv.ort', 146972408),
            ('encoder.ort', 'https://download.moonshine.ai/model/medium-streaming-en/quantized_26_07_30/encoder.ort', 94705376),
            ('frontend.ort', 'https://download.moonshine.ai/model/medium-streaming-en/quantized_26_07_30/frontend.ort', 47467576),
            ('streaming_config.json', 'https://download.moonshine.ai/model/medium-streaming-en/quantized_26_07_30/streaming_config.json', 513),
            ('tokenizer.bin', 'https://download.moonshine.ai/model/medium-streaming-en/quantized_26_07_30/tokenizer.bin', 249974)
        ]
    }
}

def download_model(model_key='medium'):
    cfg = MODELS[model_key]
    target_dir = os.path.abspath(cfg['dir'])
    os.makedirs(target_dir, exist_ok=True)

    print(f"==> Downloading Moonshine '{model_key}' model into {target_dir}...")
    t_start = time.time()

    for name, url, expected_size in cfg['files']:
        dest = os.path.join(target_dir, name)
        if os.path.exists(dest) and os.path.getsize(dest) == expected_size:
            print(f"  [OK] {name} already exists ({expected_size:,} bytes)")
            continue

        print(f"  [>] Downloading {name} ({expected_size / 1024 / 1024:.2f} MB)...", flush=True)
        t0 = time.time()
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req) as resp, open(dest, 'wb') as f:
            while True:
                chunk = resp.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
        t1 = time.time()
        print(f"  [+] Saved {name} in {t1-t0:.2f}s")

    print(f"==> All Moonshine files ready in {time.time() - t_start:.2f}s!")

if __name__ == '__main__':
    download_model('medium')
