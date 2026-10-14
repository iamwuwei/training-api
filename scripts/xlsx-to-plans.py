#!/usr/bin/env python3
"""Convert the 課表 workbook (in the sibling `running` repo) into seed/plans.json.

Usage:  python3 scripts/xlsx-to-plans.py [path/to/課表.xlsx]
Writes  seed/plans.json

Reads
  課表   A–I  -> sessions (plan)           J–W -> results (actuals, hand-typed verdicts)
  週總覽 A–D, I -> weeks (phase + focus)
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

# 類型 (column E) -> easy | long | tempo | interval | rest | race.
# The original label is kept in `label` for the UI avatars (E / R / L / MP / 坡 / 肌).
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

PACE_RANGE = re.compile(r"(\d):(\d\d)\s*[〜~\-–]\s*(\d):(\d\d)")
PACE_PLUS = re.compile(r"(\d):(\d\d)\s*\+")
HR_RANGE = re.compile(r"心拍\s*(\d{2,3})\s*[〜~\-–]\s*(\d{2,3})")
HR_MAX = re.compile(r"心拍\s*[≤<=＜]+\s*(\d{2,3})")
TIME_RE = re.compile(r"^(?:(\d+):)?(\d{1,2}):(\d{2})$")


def sec(m: int, s: int) -> int:
    return m * 60 + s


def parse_target(target: str) -> dict:
    """G column -> pace min/max (sec/km), hr min/max, and a midpoint pace."""
    out = {"pace_min_sec_km": None, "pace_max_sec_km": None, "hr_min": None, "hr_max": None}
    if not target:
        out["pace_sec_km"] = None
        return out
    rng = PACE_RANGE.search(target)
    if target.startswith("上坡") and "MP" not in target:
        rng = None  # "上坡 6:00 以內" is an effort cap, not an average pace
    if rng:
        out["pace_min_sec_km"] = sec(int(rng.group(1)), int(rng.group(2)))
        out["pace_max_sec_km"] = sec(int(rng.group(3)), int(rng.group(4)))
    else:
        plus = PACE_PLUS.search(target)
        if plus:  # "7:45+" = at least this slow
            out["pace_min_sec_km"] = sec(int(plus.group(1)), int(plus.group(2)))
    hr = HR_RANGE.search(target)
    if hr:
        out["hr_min"], out["hr_max"] = int(hr.group(1)), int(hr.group(2))
    else:
        hrm = HR_MAX.search(target)
        if hrm:
            out["hr_max"] = int(hrm.group(1))
    lo, hi = out["pace_min_sec_km"], out["pace_max_sec_km"]
    out["pace_sec_km"] = round((lo + hi) / 2) if lo and hi else lo
    return out


def text(v) -> str:
    return str(v).strip() if v is not None else ""


def num(v):
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def time_sec(v) -> int | None:
    m = TIME_RE.match(text(v))
    if not m:
        return None
    h = int(m.group(1) or 0)
    return h * 3600 + int(m.group(2)) * 60 + int(m.group(3))


def pace_sec(v) -> int | None:
    m = re.match(r"^(\d+):(\d{2})$", text(v))
    return sec(int(m.group(1)), int(m.group(2))) if m else None


def main(xlsx: pathlib.Path) -> None:
    wb = openpyxl.load_workbook(xlsx, data_only=True)

    weeks = []
    for r in wb["週總覽"].iter_rows(min_row=2, values_only=True):
        if not isinstance(r[0], (int, float)) or not isinstance(r[1], dt.datetime):
            continue
        weeks.append({
            "week_no": int(r[0]),
            "start": r[1].date().isoformat(),
            "end": r[2].date().isoformat(),
            "phase": text(r[3]) or None,
            "focus": text(r[8]) or None,
        })

    sessions, results, unknown = [], [], set()
    for r in wb["課表"].iter_rows(min_row=2, values_only=True):
        if not isinstance(r[1], dt.datetime):
            continue
        date = r[1].date().isoformat()
        label = text(r[4])
        kind = TYPE_MAP.get(label)
        if kind is None:
            unknown.add(label)
            continue
        target = text(r[6])
        sessions.append({
            "date": date,
            "week_no": int(r[0]) if isinstance(r[0], (int, float)) else None,
            "phase": text(r[3]) or None,
            "label": label,
            "type": kind,
            "distance_m": int(round(float(r[5] or 0) * 1000)),
            "content": text(r[7]) or None,
            "note": text(r[8]) or None,
            "target": target or None,
            **parse_target(target),
        })
        # actuals (J–W), hand-typed; only rows with a verdict or a distance
        if num(r[9]) is not None or text(r[21]):
            reminders = [s.strip() for s in text(r[22]).split("｜") if s.strip()]
            results.append({
                "date": date,
                "distance_m": int(round((num(r[9]) or 0) * 1000)),
                "memo": text(r[11]) or None,
                "moving_time_sec": time_sec(r[12]),
                "pace_sec_km": pace_sec(r[13]),
                "avg_hr": int(num(r[14])) if num(r[14]) is not None else None,
                "max_hr": int(num(r[15])) if num(r[15]) is not None else None,
                "avg_watts": int(num(r[16])) if num(r[16]) is not None else None,
                "kcal": int(num(r[17])) if num(r[17]) is not None else None,
                "weather": text(r[18]) or None,
                "shoes": text(r[19]) or None,
                "device": text(r[20]) or None,
                "verdict": text(r[21]) or None,
                "reminders": reminders,
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
        "weeks": weeks,
        "sessions": sessions,
        "results": results,
    }]
    OUT.write_text(json.dumps(plans, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(weeks)} weeks, {len(sessions)} sessions "
          f"({sessions[0]['date']} → {sessions[-1]['date']}), {len(results)} results")


if __name__ == "__main__":
    main(pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_XLSX)
