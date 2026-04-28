"""
TW Barbar Köy Monitörü
======================
Kaynak: https://{sunucu}/map/village.txt.gz (giriş gerekmez, Innogames harita dökümü)

Akış:
  1) .gz indir → metin aç
  2) Satırları parse et → yalnızca player_id == 0 (barbar)
  3) İsteğe bağlı: kıta anahtarı ile filtre (K55 → "55", …)
  4) Yeni köy id'leri (state ile diff) → Telegram

Kurulum:
    pip install requests

Çalıştırma (repo kökünden):
    python scripts/tw_barbar_monitor.py

PM2: ecosystem.config.cjs içindeki tw-barbar-monitor uygulamasına bakın.
"""

from __future__ import annotations

import gzip
import io
import json
import os
import time
import urllib.parse
from datetime import datetime

import requests

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

# ─────────────────────────────────────────────
#  AYARLAR
# ─────────────────────────────────────────────
TELEGRAM_BOT_TOKEN = "BOT_TOKEN_BURAYA"
TELEGRAM_CHAT_ID = "CHAT_ID_BURAYA"

SERVER = "tr101.klanlar.org"
CHECK_INTERVAL = 120  # saniye (2 dk)

# Sadece bu kıtalardaki barbarlar izlenir ve state'e yazılır.
# Boş liste [] = tüm haritadaki barbarlar (dosya büyüyebilir).
# Kıta anahtarı: str(y // 100) + str(x // 100)  →  örn. (555|523) → K55 → "55"
WATCH_CONTINENTS: list[str] = ["55"]

MIN_POINTS = 0
MAX_POINTS = 500

STATE_FILE = os.path.join(_REPO_ROOT, "barbar_state.json")
# ─────────────────────────────────────────────


def log(msg: str) -> None:
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}")


def village_gz_url(server: str) -> str:
    return f"https://{server}/map/village.txt.gz"


def continent_key(x: int, y: int) -> str:
    """TW kıta kodu: K{floor(y/100)}{floor(x/100)} → iç depolama '55', '45' vb."""
    return f"{y // 100}{x // 100}"


def world_slug_from_server(server: str) -> str:
    """tr101.klanlar.org → tr101; trp12.klanlar.org → trp12 (harita linki için)."""
    host = server.strip().lower().split("/")[0]
    return host.split(".")[0] if host else "tr101"


def fetch_village_gz_text(server: str, timeout: int = 60) -> str:
    """Ham village.txt içeriği (gzip açılmış)."""
    url = village_gz_url(server)
    resp = requests.get(
        url,
        timeout=timeout,
        headers={"User-Agent": "Mozilla/5.0 tw-barbar-monitor/1.0"},
    )
    resp.raise_for_status()
    with gzip.open(io.BytesIO(resp.content)) as f:
        return f.read().decode("utf-8", errors="replace")


def parse_all_barbar_villages(text: str) -> dict[int, dict]:
    """
    Tüm haritadaki barbar köyler.
    Dönüş: {village_id: {id, x, y, coord, name, pts, cont}}
    """
    villages: dict[int, dict] = {}
    for line in text.strip().splitlines():
        parts = line.split(",")
        if len(parts) < 6:
            continue
        try:
            vid = int(parts[0])
            x = int(parts[2])
            y = int(parts[3])
            pid = int(parts[4])
            pts = int(parts[5])
        except (ValueError, IndexError):
            continue
        if pid != 0:
            continue

        name = parts[1]
        try:
            name = urllib.parse.unquote_plus(name)
        except Exception:
            pass

        cont = continent_key(x, y)
        villages[vid] = {
            "id": vid,
            "x": x,
            "y": y,
            "coord": f"{x}|{y}",
            "name": name,
            "pts": pts,
            "cont": cont,
        }
    return villages


def filter_barbar_by_continents(
    barbs: dict[int, dict],
    continents: list[str] | None,
) -> dict[int, dict]:
    """continents boş veya None ise tüm barbarlar; aksi halde yalnızca cont eşleşenler."""
    if not continents:
        return dict(barbs)
    want = {c.strip() for c in continents if c and str(c).strip()}
    return {vid: v for vid, v in barbs.items() if v["cont"] in want}


def filter_by_points(v: dict, lo: int, hi: int) -> bool:
    return lo <= int(v.get("pts", 0)) <= hi


def load_state() -> dict:
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_state(villages: dict[int, dict]) -> None:
    data = {str(vid): {k: v[k] for k in ("coord", "name", "pts", "cont") if k in v} for vid, v in villages.items()}
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def send_telegram(message: str) -> None:
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": message,
        "parse_mode": "Markdown",
    }
    try:
        r = requests.post(url, json=payload, timeout=15)
        r.raise_for_status()
    except Exception as e:
        log(f"Telegram gönderilemedi: {e}")


def build_message(new_barbs: list[dict]) -> str:
    kita_listesi = ", ".join(f"K{c}" for c in WATCH_CONTINENTS) if WATCH_CONTINENTS else "Tümü"
    slug = world_slug_from_server(SERVER)
    header = (
        f"⚔ *{len(new_barbs)} yeni barbar köy* bulundu!\n"
        f"_(İzlenen kıtalar: {kita_listesi})_\n\n"
    )
    rows = []
    for v in sorted(new_barbs, key=lambda x: x["pts"]):
        coord = v["coord"]
        map_url = f"https://{slug}.tribalwarsmap.com/tr/#{coord}"
        rows.append(
            f"📍 `{coord}` — *{v['pts']} puan* — K{v['cont']}\n"
            f"   [{v['name']}]({map_url})"
        )
    return header + "\n".join(rows)


def run_cycle(
    *,
    all_barbs: dict[int, dict],
    known: dict[str, dict],
    first_run: bool,
) -> tuple[dict[str, dict], bool]:
    """
    İzlenen kıtalara göre filtrelenmiş barbar kümesi üzerinde diff.
    Döner: (yeni_known_dict, first_run_bitti_mi)
    """
    scoped = filter_barbar_by_continents(all_barbs, WATCH_CONTINENTS)

    if first_run:
        save_state(scoped)
        log(
            f"İlk durum kaydedildi: {len(scoped)} barbar "
            f"({'izlenen kıtalar' if WATCH_CONTINENTS else 'tüm harita'})."
        )
        return {str(vid): v for vid, v in scoped.items()}, False

    new_barbs: list[dict] = []
    for vid, data in scoped.items():
        if str(vid) in known:
            continue
        if not filter_by_points(data, MIN_POINTS, MAX_POINTS):
            continue
        new_barbs.append(data)

    if new_barbs:
        log(f"🆕 {len(new_barbs)} YENİ barbar köy!")
        send_telegram(build_message(new_barbs))
    else:
        log("Yeni barbar köy yok (izlenen kıta + puan aralığında).")

    merged = {str(vid): v for vid, v in scoped.items()}
    save_state(scoped)
    return merged, False


def main() -> None:
    log("Barbar monitör başlatıldı.")
    log(f"Kaynak : {village_gz_url(SERVER)}")
    log(f"Sunucu : {SERVER}")
    log(f"Kıtalar: {WATCH_CONTINENTS or '[] = tüm harita'}")
    log(f"Puan   : {MIN_POINTS}–{MAX_POINTS}")
    log(f"Aralık : {CHECK_INTERVAL} sn")
    log(f"State  : {STATE_FILE}")
    print("-" * 50)

    known: dict[str, dict] = load_state()
    if known:
        log(f"Önceki oturumdan {len(known)} kayıt (izlenen kıta barbar state).")
    else:
        log("İlk çalıştırma — bildirim gönderilmeden önce durum kaydedilecek.")

    first_run = not bool(known)

    while True:
        try:
            log("village.txt.gz indiriliyor…")
            text = fetch_village_gz_text(SERVER)
            all_barbs = parse_all_barbar_villages(text)
            log(f"Parse: {len(all_barbs)} barbar (tüm harita).")

            scoped = filter_barbar_by_continents(all_barbs, WATCH_CONTINENTS)
            log(f"Kıta filtresi sonrası: {len(scoped)} barbar.")

            known, first_run = run_cycle(all_barbs=all_barbs, known=known, first_run=first_run)

        except requests.RequestException as e:
            log(f"Ağ hatası: {e}")
        except Exception as e:
            log(f"Beklenmeyen hata: {e}")

        log(f"Sonraki kontrol {CHECK_INTERVAL // 60} dk sonra…")
        time.sleep(CHECK_INTERVAL)


if __name__ == "__main__":
    main()
