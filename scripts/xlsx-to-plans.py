#!/usr/bin/env python3
"""Convert the 課表 workbook in the parent repo into seed/plans.json.

Usage:  python3 scripts/xlsx-to-plans.py [path/to/課表.xlsx]
Writes  seed/plans.json

Only columns A–I (the plan) are read; actual results (J–W) stay in the xlsx.
Unknown 類型 values abort with a list so they can be added to TYPE_MAP.
"""
from __future__ import annotations

import datetime as dt
import json
import pathlib
import re
import sys

import openpyxl

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
DEFAULT_XLSX = ROOT.parent / "running" / "富士山馬拉松_2026_課表.xlsx"  # ../running checkout
OUT = ROOT / "seed" / "plans.json"

USER = "ww"
RACE_NAME = "富士山マラソン"
RACE_DATE = "2026-12-14"
GOAL_TIME_SEC = 4 * 3600 + 45 * 60   # 比賽目標 4:45
DAYS_PER_WEEK = 4

# 類型 (column E) -> easy | long | tempo | interval | rest | race
TYPE_MAP = {
    "Easy": "easy",
    "Recovery": "easy",
    "快步": "easy",          # easy run + strides
    "Long": "long",
    "Peak Long": "long",
    "MP": "tempo",           # marathon-pace segments
    "坡跑": "interval",      # hill repeats
    "坡跑+MP": "interval",
    "休息": "rest",
    "完全休息": "rest",
    "肌力": "rest",          # strength / Hyrox day, no running
    "比賽": "race",
}
# Keep the original label in the note when the mapping loses information.
KEEP_LABEL = {"Recovery", "快步", "Peak Long", "MP", "坡跑", "坡跑+MP", "肌力", "完全休息"}

PACE_RANGE = re.compile(r"(\d):(\d\d)\s*[〜~\-–]\s*(\d):(\d\d)")
PACE_PLUS = re.compile(r"(\d):(\d\d)\s*\+")
PACE_SINGLE = re.compile(r"(\d):(\d\d)")


def pace_sec(target: str | None) -> int | None:
    """First pace range in G -> midpoint in sec/km; '7:45+' -> 465; none -> None."""
    if not target:
        return None
    if target.startswith("上坡"):
        # hill repeats: "上坡 6:00 以內" is an effort cap, not an average pace;
        # keep only an explicit MP range if one follows (坡跑+MP).
        m = PACE_RANGE.search(target)
        return round((int(m.group(1)) * 60 + int(m.group(2)) + int(m.group(3)) * 60 + int(m.group(4))) / 2) if m else None
    m = PACE_RANGE.search(target)
    if m:
        a = int(m.group(1)) * 60 + int(m.group(2))
        b = int(m.group(3)) * 60 + int(m.group(4))
        return round((a + b) / 2)
    m = PACE_PLUS.search(target) or PACE_SINGLE.search(target)
    if m:
        return int(m.group(1)) * 60 + int(m.group(2))
    return None


def text(v) -> str:
    return str(v).strip() if v is not None else ""


def main(xlsx: pathlib.Path) -> None:
    ws = openpyxl.load_workbook(xlsx, data_only=True)["課表"]
    sessions, unknown = [], set()
    for r in ws.iter_rows(min_row=2, values_only=True):
        if not isinstance(r[1], dt.datetime):
            continue
        label = text(r[4])
        kind = TYPE_MAP.get(label)
        if kind is None:
            unknown.add(label)
            continue
        km = float(r[5] or 0)
        note_parts = [text(r[7])]
        if text(r[8]):
            note_parts.append(text(r[8]))
        note = "｜".join(p for p in note_parts if p)
        if label in KEEP_LABEL:
            note = f"[{label}] {note}"
        sessions.append({
            "date": r[1].date().isoformat(),
            "type": kind,
            "distance_m": int(round(km * 1000)),
            "pace_sec_km": pace_sec(text(r[6])),
            "note": note,
        })
    if unknown:
        sys.exit(f"unmapped 類型 values: {sorted(unknown)} — add them to TYPE_MAP")

    sessions.sort(key=lambda s: s["date"])
    plans = [{
        "user": USER,
        "race_name": RACE_NAME,
        "race_date": RACE_DATE,
        "goal_time_sec": GOAL_TIME_SEC,
        "days_per_week": DAYS_PER_WEEK,
        "sessions": sessions,
    }]
    OUT.write_text(json.dumps(plans, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(sessions)} sessions ({sessions[0]['date']} → {sessions[-1]['date']})")


if __name__ == "__main__":
    main(pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_XLSX)
