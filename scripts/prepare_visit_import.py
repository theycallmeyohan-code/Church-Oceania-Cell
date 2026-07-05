import csv
import hashlib
import json
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path


DOC_ID = "1egK_qw0x0SS4DpTXir0xLiJzbZNwuHr0cWJ0V-ov_TU"
SOURCE = "google-docs-2026-visit-log"

TITLE_WORDS = [
    "권사님",
    "집사님",
    "성도님",
    "장로님",
    "목사님",
    "전도사님",
    "권사",
    "집사",
    "성도",
    "장로",
    "목사",
    "전도사",
    "간사",
    "청년",
    "새가족",
]

BOILERPLATE_PATTERNS = [
    r"말씀으로 권면과 중보기도를 하였(?:습니다|음)\.?",
    r"말씀으로 권면.*?하였(?:습니다|음)\.?",
    r"중보기도를 하였(?:습니다|음)\.?",
    r"꾸준한 소통을 통해.*?(?:살피며 돌보는 중입니다|격려하고 있습니다)\.?",
    r"셀 차원에서 지속적으로 교제하며.*?(?:돌보는 중입니다|격려하고 있습니다)\.?",
    r"늘 기도하고 있음을 전하며\s*",
]

GENERIC_PHRASES = [
    "특별한 어려움 없이",
    "평안하게 잘 지내",
    "건강히 잘 지내",
    "특별한 문제 없이",
    "영적 상태를 살피",
    "지속적인 격려",
    "기도하고 있음을",
]

PRAYER_PATTERNS = [
    r"([^.!?\n。]*?(?:기도(?:를)?\s*(?:요청|부탁)|기도제목(?:을)?\s*나누|간구하고 있)[^.!?\n。]*[.!?。]?)",
    r"([^.!?\n。]*?위해(?:서도)?\s*기도(?:해|를)?\s*(?:달라고|부탁|요청)[^.!?\n。]*[.!?。]?)",
]


def normalize_ws(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def strip_titles(value):
    text = re.sub(r"\([^)]*\)", " ", str(value or ""))
    text = re.sub(r"\b\d{2,}\b", " ", text)
    text = re.sub(r"(?<!\d)\d+(?!\d)", " ", text)
    for word in TITLE_WORDS:
        text = text.replace(word, " ")
    text = re.sub(r"[\s\-_*·:]+", " ", text)
    return normalize_ws(text)


def normalize_name(value):
    return re.sub(r"\s+", "", strip_titles(value))


def normalize_cell(value):
    text = str(value or "")
    match = re.search(r"(남|여)\s*(?:자\s*)?(\d+)\s*셀", text)
    if not match:
        return ""
    gender = "남자" if match.group(1) == "남" else "여자"
    return f"{gender} {int(match.group(2))}셀"


def cell_from_text(value):
    return normalize_cell(value)


def clean_body(text):
    raw_lines = str(text or "").replace("\ufeff", "").splitlines()
    kept_lines = []
    for line in raw_lines:
        stripped = line.strip()
        if not stripped:
            continue
        label_text = stripped.replace("📞", "").strip()
        if re.match(r"^[-–]?\s*(?:(?:남|여)\s*\d+\s*셀\s*)?[\w가-힣\s\d()]+(?:권사|집사|성도|장로|목사|전도사|간사)(?:\([^)]*\))?\s*-?\s*$", label_text):
            continue
        if re.match(r"^[-–]?\s*믿음\d+(?:\s*새가족)?\s+[\w가-힣\s\d()]+(?:권사|집사|성도|장로)?\s*-?\s*$", label_text):
            continue
        if re.match(r"^[\w가-힣\s\d()]+-\s*$", label_text):
            continue
        kept_lines.append(stripped)
    cleaned = "\n".join(kept_lines)
    cleaned = cleaned.replace("📞", "")
    for pattern in BOILERPLATE_PATTERNS:
        cleaned = re.sub(pattern, " ", cleaned)
    cleaned = re.sub(r"^-+\s*$", " ", cleaned, flags=re.MULTILINE)
    cleaned = re.sub(r"^\s*-\s*(?:남|여)\s*\d+\s*셀\s+[^-\n]+-\s*$", " ", cleaned, flags=re.MULTILINE)
    cleaned = re.sub(r"^\s*-\s*믿음\d+\s+[^-\n]+-\s*$", " ", cleaned, flags=re.MULTILINE)
    cleaned = re.sub(r"^\s*[-–]\s*", "", cleaned, flags=re.MULTILINE)
    return normalize_ws(cleaned)


def split_sentences(text):
    text = normalize_ws(text)
    if not text:
        return []
    parts = re.split(r"(?<=[.!?。])\s+|(?<=다\.)\s+|(?<=함\.)\s+|(?<=음\.)\s+", text)
    sentences = []
    for part in parts:
        part = normalize_ws(part)
        if not part:
            continue
        if not re.search(r"[.!?。]$", part) and len(part) > 35:
            part += "."
        sentences.append(part)
    return sentences


def sentence_score(sentence):
    text = sentence
    if re.search(r"기도제목|(?:중보)?기도(?:를)?\s*(?:요청|부탁)|간구", text):
        return -100
    score = 0
    if re.search(r"\d|월|일|주|년|병원|의원|수술|입원|퇴원|치료|약|검사|진단|통증|부종|골다공증|우울증|복통|몸살|인대|심장|판막|간 수치|폐|복수", text):
        score += 4
    if re.search(r"남편|아내|자녀|아들|딸|손녀|손주|배우자|모친|부친|가정|친정|부모", text):
        score += 2
    if re.search(r"직장|근무|출근|퇴사|이직|취업|사업|사무실|부동산|대출|재정|상환|폐업|계약|이사|학교|학원|입학|시험", text):
        score += 3
    if re.search(r"예배|셀 모임|새벽|금요|교회|봉사|사역", text):
        score += 1
    if any(phrase in text for phrase in GENERIC_PHRASES):
        score -= 5
    if re.search(r"안부|격려|권면|중보기도|기도하고|살피며|돌보는 중", text):
        score -= 2
    if re.search(r"안부(?:를)?\s*확인하고자|안부차\s*연락|안부\s*전화", text):
        score -= 4
    if len(text) < 18:
        score -= 2
    return score


def extract_prayer(text):
    prayers = []
    for pattern in PRAYER_PATTERNS:
        for match in re.finditer(pattern, text):
            sentence = normalize_ws(match.group(1))
            sentence = re.sub(r"말씀으로 권면.*$", "", sentence).strip()
            sentence = re.sub(r"^(?:또한|그리고)\s+", "", sentence).strip()
            if sentence and "중보기도를 하였습니다" not in sentence:
                prayers.append(sentence.rstrip("."))
    unique = []
    for prayer in prayers:
        if prayer not in unique:
            unique.append(prayer)
    return " ".join(unique[:2]).strip()


def build_summary(entry):
    topic = normalize_ws(entry.get("topic"))
    one_line = normalize_ws(entry.get("oneLine"))
    body = clean_body(entry.get("body"))
    prayer = extract_prayer(body)

    body_for_summary = body
    if prayer:
        body_for_summary = body_for_summary.replace(prayer, " ")

    sentences = split_sentences(body_for_summary)
    ranked = sorted(
        enumerate(sentences),
        key=lambda item: (sentence_score(item[1]), -item[0]),
        reverse=True,
    )
    selected_indexes = sorted(index for index, sentence in ranked[:3] if sentence_score(sentence) > -1)
    selected = [sentences[index] for index in selected_indexes[:2]]

    if not selected and one_line and not any(phrase in one_line for phrase in ["안부 확인", "특이사항 없음"]):
        selected = [one_line.rstrip(".") + "."]

    if topic and not selected:
        selected = [topic.rstrip(".") + "."]

    summary = " ".join(selected)
    summary = normalize_ws(summary)
    if len(summary) > 340:
        summary = summary[:337].rstrip() + "..."
    return summary, prayer


def parse_entries(text):
    current_date = ""
    current_weekday = ""
    entries = []
    parts = re.split(r"\n\s*-------------------------\s*\n", text.replace("\r\n", "\n"))
    date_re = re.compile(r"━━━\s*(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s*\(([^)]+)\)\s*━━━")
    for part in parts:
        part = part.strip()
        if not part:
            continue
        date_matches = list(date_re.finditer(part))
        if date_matches:
            last = date_matches[-1]
            current_date = f"{int(last.group(1)):04d}-{int(last.group(2)):02d}-{int(last.group(3)):02d}"
            current_weekday = last.group(4)
            part = part[last.end():].strip()
            if not part:
                continue
        if not current_date:
            continue
        lines = [line.strip() for line in part.split("\n") if line.strip()]
        if not lines:
            continue
        header = lines[0]
        one_line = ""
        body_lines = []
        for line in lines[1:]:
            match = re.match(r"^\[한줄 요약\]\s*(.+)$", line)
            if match:
                one_line = match.group(1).strip()
                continue
            body_lines.append(line)
        header_match = re.match(r"^(.*?)\s*\((오전|오후)\s*([0-9:]+)\)\s*(?:\*(.*))?$", header)
        raw_name = header
        time_text = ""
        topic = ""
        if header_match:
            raw_name = header_match.group(1).strip()
            time_text = f"{header_match.group(2)} {header_match.group(3)}"
            topic = normalize_ws(header_match.group(4) or "")
        body = "\n".join(body_lines)
        cell_hint = cell_from_text(header + "\n" + body)
        body_name = ""
        body_name_match = re.search(r"-\s*(?:(?:남|여)\s*\d+\s*셀|믿음\d+(?:\s*새가족)?)\s+([가-힣A-Za-z0-9\s]+?)\s*(?:권사|집사|성도|장로|목사|전도사|간사)?\s*-", body)
        if body_name_match:
            body_name = body_name_match.group(1).strip()
        entries.append({
            "index": len(entries) + 1,
            "date": current_date,
            "weekday": current_weekday,
            "header": header,
            "rawName": raw_name,
            "bodyName": body_name,
            "time": time_text,
            "topic": topic,
            "oneLine": one_line,
            "body": body,
            "cellHint": cell_hint,
        })
    return entries


def load_members(path):
    payload = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    rows = payload[0]["results"] if isinstance(payload, list) else payload["results"]
    return [row for row in rows if not row.get("archivedAt")]


def build_member_indexes(members):
    by_name = {}
    by_name_cell = {}
    for member in members:
        key = normalize_name(member["name"])
        by_name.setdefault(key, []).append(member)
        cell_key = (key, member.get("cellName", ""))
        by_name_cell.setdefault(cell_key, []).append(member)
    return by_name, by_name_cell


def resolve_member(entry, by_name, by_name_cell):
    raw = entry["rawName"]
    body_name = entry["bodyName"]
    candidates = [raw, body_name]

    if "김미숙12" in raw.replace(" ", ""):
        matches = [member for members in by_name.values() for member in members if member["name"] == "김미숙" and "B" in member.get("title", "")]
        if matches:
            return matches[0], "special:김미숙12"

    raw_compact = raw.replace(" ", "")
    if raw_compact in ["김미숙집사", "김미숙권사", "김미숙"] or ("김미숙" in raw_compact and "기도장" in raw_compact):
        matches = [member for members in by_name.values() for member in members if member["name"] == "김미숙" and member.get("role") == "prayer_leader"]
        if matches:
            return matches[0], "special:김미숙기도장"

    for candidate in candidates:
        key = normalize_name(candidate)
        if not key:
            continue
        if entry["cellHint"]:
            matches = by_name_cell.get((key, entry["cellHint"]), [])
            if len(matches) == 1:
                return matches[0], "name+cell"
        matches = by_name.get(key, [])
        if len(matches) == 1:
            return matches[0], "unique-name"
    return None, "unmatched"


def should_exclude(entry, member, summary, prayer):
    if not member:
        return True, "no-member-match"
    raw = entry["rawName"].replace(" ", "")
    if raw in ["와이프", "아버지", "삼성카드", "89"]:
        return True, "personal-or-system"
    if re.search(r"목사|전도사|간사|청년", entry["rawName"]) and not member:
        return True, "staff-or-personal"
    if not summary:
        return True, "empty-summary"
    if not prayer and is_low_info_summary(summary):
        return True, "low-info-summary"
    return False, ""


def is_low_info_summary(summary):
    text = normalize_ws(summary)
    if not text:
        return True
    concrete = re.search(
        r"\d|병원|의원|수술|입원|퇴원|치료|검사|진단|약|통증|부상|부종|암|골다공증|"
        r"직장|근무|출근|퇴사|이직|취업|사업|사무실|대출|재정|상환|계약|이사|"
        r"학교|학원|입학|시험|출산|임신|예배|셀 모임|카톡방|음성 메시지|미연결",
        text,
    )
    if concrete:
        return False
    return len(text) < 90 and re.search(r"안부|근황|평안|특이사항|건강", text)


def sql_quote(value):
    return "'" + str(value or "").replace("'", "''") + "'"


def main():
    if len(sys.argv) != 5:
        print("usage: prepare_visit_import.py doc.txt members.json out.csv out.sql", file=sys.stderr)
        return 2
    doc_path, members_path, csv_path, sql_path = map(Path, sys.argv[1:])
    text = doc_path.read_text(encoding="utf-8-sig")
    members = load_members(members_path)
    by_name, by_name_cell = build_member_indexes(members)
    entries = parse_entries(text)
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    rows = []
    seen = set()
    for entry in entries:
        member, match_type = resolve_member(entry, by_name, by_name_cell)
        summary, prayer = build_summary(entry)
        excluded, exclude_reason = should_exclude(entry, member, summary, prayer)
        dedupe_key = (member.get("id") if member else "", entry["date"], entry["time"], normalize_name(entry["rawName"]))
        if not excluded and dedupe_key in seen:
            excluded = True
            exclude_reason = "duplicate-same-member-date-time"
        if not excluded:
            seen.add(dedupe_key)
        stable = "|".join([DOC_ID, entry["date"], entry["time"], entry["header"], member.get("id") if member else ""])
        visit_id = "gdoc-2026-" + hashlib.sha1(stable.encode("utf-8")).hexdigest()[:24]
        raw_payload = json.dumps({
            "documentId": DOC_ID,
            "source": SOURCE,
            "entryIndex": entry["index"],
            "header": entry["header"],
            "matchType": match_type,
        }, ensure_ascii=False)
        rows.append({
            "status": "exclude" if excluded else "ready",
            "excludeReason": exclude_reason,
            "visitId": visit_id,
            "memberId": member.get("id", "") if member else "",
            "memberName": member.get("name", "") if member else "",
            "memberTitle": member.get("title", "") if member else "",
            "memberCell": member.get("cellName", "") if member else "",
            "matchType": match_type,
            "visitDate": entry["date"],
            "visitType": "전화",
            "summary": summary,
            "prayer": prayer,
            "source": SOURCE,
            "rawPayload": raw_payload,
            "createdAt": now,
            "docHeader": entry["header"],
            "cellHint": entry["cellHint"],
            "topic": entry["topic"],
            "oneLine": entry["oneLine"],
        })

    with csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    ready = [row for row in rows if row["status"] == "ready"]
    statements = []
    for row in ready:
        values = [
            row["visitId"],
            row["memberId"],
            row["visitDate"],
            row["visitType"],
            row["summary"],
            row["prayer"],
            "",
            row["source"],
            row["rawPayload"],
            row["createdAt"],
        ]
        statements.append(
            "INSERT OR IGNORE INTO visit_notes "
            "(id, member_id, visit_date, visit_type, summary, prayer, action, source, raw_payload, created_at) "
            f"VALUES ({', '.join(sql_quote(value) for value in values)});"
        )
    sql_path.write_text("\n".join(statements) + "\n", encoding="utf-8")

    counts = {}
    for row in rows:
        key = row["status"] if row["status"] == "ready" else f"exclude:{row['excludeReason']}"
        counts[key] = counts.get(key, 0) + 1
    print(json.dumps({
        "entries": len(entries),
        "ready": len(ready),
        "counts": counts,
        "csv": str(csv_path),
        "sql": str(sql_path),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
