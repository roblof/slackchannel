#!/usr/bin/env python3
"""Skicka Slack-påminnelser för uppgifter i oppgaver.yaml.

Körs av GitHub Actions på schema. Postar en påminnelse till Slack
(via Incoming Webhook) ett par timmar innan varje uppgifts deadline.
Redan skickade påminnelser spåras i .paminnelse_state.json så att
ingen påminnelse skickas två gånger.
"""
import json
import os
import sys
import urllib.request
import urllib.error
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TASKS_FILE = os.path.join(ROOT, "oppgaver.yaml")
STATE_FILE = os.path.join(ROOT, ".paminnelse_state.json")


def ladda_tasks():
    with open(TASKS_FILE, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def ladda_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    return {"skickade": {}}


def spara_state(state):
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
        f.write("\n")


def parse_deadline(s, tz):
    s = str(s).strip().replace("T", " ")
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=tz)
        except ValueError:
            continue
    raise ValueError(s)


def resolve_ansvarig(ansvarig, medlemmar):
    if not ansvarig:
        return "okänd"
    a = str(ansvarig).strip()
    key = a.lstrip("@")
    if key in medlemmar:
        return f"<@{medlemmar[key]}>"
    if (a.startswith("U") or a.startswith("W")) and a[1:].isalnum() and len(a) >= 9:
        return f"<@{a}>"
    return a


def posta_slack(webhook, text):
    payload = json.dumps({"text": text}).encode("utf-8")
    req = urllib.request.Request(
        webhook, data=payload, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.status


def main():
    webhook = os.environ.get("SLACK_WEBHOOK_URL")
    data = ladda_tasks()
    inst = data.get("installningar", {}) or {}
    tz = ZoneInfo(inst.get("tidszon", "Europe/Stockholm"))
    std_timmar = float(inst.get("paminnelse_timmar_innan", 2))
    medlemmar = inst.get("medlemmar", {}) or {}

    nu_env = os.environ.get("PAMINNELSE_NU")
    if nu_env:
        nu = datetime.fromisoformat(nu_env)
        if nu.tzinfo is None:
            nu = nu.replace(tzinfo=tz)
    else:
        nu = datetime.now(tz)

    state = ladda_state()
    skickade = state.setdefault("skickade", {})

    att_skicka = []
    for u in data.get("uppgifter", []) or []:
        status = str(u.get("status", "open")).strip().lower()
        if status not in ("open", "öppen", "oppen", ""):
            continue
        if not u.get("deadline"):
            continue
        try:
            dl = parse_deadline(u["deadline"], tz)
        except ValueError:
            print(f"Hoppar över uppgift med ogiltig deadline: {u.get('deadline')!r}")
            continue
        timmar = float(u.get("paminnelse_timmar_innan", std_timmar))
        uid = str(u.get("id") or u.get("uppgift"))
        nyckel = f"{uid}@{dl.isoformat()}"
        if skickade.get(nyckel):
            continue
        remaining = dl - nu
        if timedelta(0) < remaining <= timedelta(hours=timmar):
            att_skicka.append((nyckel, u, dl, remaining))

    if not att_skicka:
        print("Inga påminnelser att skicka just nu.")
        spara_state(state)
        return 0

    for nyckel, u, dl, remaining in att_skicka:
        ansvarig = resolve_ansvarig(u.get("ansvarig"), medlemmar)
        minuter = int(remaining.total_seconds() // 60)
        tim, mkvar = divmod(minuter, 60)
        tidtext = f"{tim} tim {mkvar} min" if tim else f"{mkvar} min"
        text = (
            f":alarm_clock: *Påminnelse:* {ansvarig} – uppgiften "
            f"*{u.get('uppgift', '(utan namn)')}* ska vara klar "
            f"{dl.strftime('%Y-%m-%d %H:%M')} (om ca {tidtext})."
        )
        if webhook:
            try:
                posta_slack(webhook, text)
                print(f"Skickade påminnelse: {nyckel}")
                skickade[nyckel] = nu.isoformat()
            except urllib.error.URLError as e:
                print(f"Kunde inte posta till Slack: {e}", file=sys.stderr)
        else:
            print("[TORRKÖR – ingen SLACK_WEBHOOK_URL satt]")
            print(text)
            skickade[nyckel] = nu.isoformat()

    spara_state(state)
    return 0


if __name__ == "__main__":
    sys.exit(main())
