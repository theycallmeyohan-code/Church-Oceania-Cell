import csv
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
import os
from pathlib import Path

import pandas as pd
import pdfplumber
from docx import Document


ROOT = Path(__file__).resolve().parents[1]
PYTHON = Path(sys.executable)
SOURCE_DIR = Path.home() / "Desktop" / "준비"

PHOTO_PDF = SOURCE_DIR / "1. 사진요람.pdf"
PROFILE_XLS = SOURCE_DIR / "2. 신상액셀.xls"
VISIT_DOCX = SOURCE_DIR / "3. 요약심방기록.docx"
PRAYER_PDF = SOURCE_DIR / "4. 새해기도제목.pdf"

OUT_DIR = ROOT / "scratch" / "oceania-private"
PHOTO_DIR = ROOT / "public" / "photos"
PRIVATE_JS = ROOT / "public" / "member-details.private.js"

COMMUNITY_TITLE = "오세아니아 공동체"
DATA_VERSION = "oceania-2026-07-08-r2-1"
PHOTO_VERSION = "20260708-oceania-r2-1"
R2_SEED_PHOTO_PREFIX = "seed/"

TITLE_WORDS = {"장로", "권사", "집사", "성도", "목사", "사모", "전도사"}
ROLE_BY_LABEL = {
    "셀장": "cell_leader",
    "부셀장": "assistant_leader",
    "기도장": "prayer_leader",
}
GENDER_PREFIX = {
    "남자": "male",
    "여자": "female",
}


def normalize_ws(value):
    return re.sub(r"\s+", " ", str(value or "").replace("\xa0", " ")).strip()


def compact(value):
    return re.sub(r"\s+", "", str(value or "")).strip()


def cell_id(label):
    match = re.search(r"(남자|여자)\s*(\d+)\s*셀", label or "")
    if not match:
        return ""
    return f"{GENDER_PREFIX[match.group(1)]}-{int(match.group(2))}"


def cell_label_from_id(value):
    match = re.match(r"^(male|female)-(\d+)$", value or "")
    if not match:
        return value or ""
    return f"{'남자' if match.group(1) == 'male' else '여자'} {int(match.group(2))}셀"


def parse_person_label(value):
    raw = normalize_ws(value)
    role = ""
    role_match = re.search(r"\((셀장|부셀장|기도장)\)", raw)
    if role_match:
        role = ROLE_BY_LABEL[role_match.group(1)]
    raw = re.sub(r"\([^)]*\)", "", raw).strip()
    parts = raw.split()
    title = ""
    if len(parts) >= 2 and parts[-1] in TITLE_WORDS:
        title = parts[-1]
        name = " ".join(parts[:-1])
    else:
        name = raw
    return {
        "raw": normalize_ws(value),
        "name": normalize_ws(name),
        "title": title,
        "role": role,
    }


def image_for_cell(images, cell):
    if not cell:
        return None
    x0, top, x1, bottom = cell
    for image in images:
        center_x = (image["x0"] + image["x1"]) / 2
        center_y = (image["top"] + image["bottom"]) / 2
        if x0 - 2 <= center_x <= x1 + 2 and top - 2 <= center_y <= bottom + 2:
            return image
    return None


def parse_roster():
    cells = []
    members = []
    seen_cells = set()

    PHOTO_DIR.mkdir(parents=True, exist_ok=True)
    for existing in PHOTO_DIR.glob("seed-*.jpg"):
        existing.unlink()

    with pdfplumber.open(PHOTO_PDF) as pdf:
        for page_index, page in enumerate(pdf.pages[1:], start=2):
            found_tables = page.find_tables()
            tables = page.extract_tables() or []
            if not tables:
                continue
            table_obj = found_tables[0] if found_tables else None
            table = tables[0]
            title = normalize_ws(table[0][0] or "")
            title_match = re.search(r"((?:남자|여자)\s*\d+\s*셀)\s*\(([^)]*)\)", title)
            if not title_match:
                continue
            current_cell_id = cell_id(title_match.group(1))
            current_cell_name = re.sub(r"\s+", " ", title_match.group(1).replace("남자", "남자 ").replace("여자", "여자 ")).strip()
            current_cell_meta = title_match.group(2).strip()
            if current_cell_id not in seen_cells:
                seen_cells.add(current_cell_id)
                cells.append({
                    "id": current_cell_id,
                    "name": current_cell_name,
                    "meta": current_cell_meta,
                    "gender": "남자" if current_cell_id.startswith("male-") else "여자",
                    "sortOrder": len(cells) * 10 + 10,
                })

            page_slots = []
            if table_obj and table_obj.rows:
                for label_row_index in range(2, min(len(table), len(table_obj.rows)), 2):
                    label_row = table[label_row_index]
                    image_cells = table_obj.rows[label_row_index - 1].cells if label_row_index - 1 < len(table_obj.rows) else []
                    for column_index, cell in enumerate(label_row):
                        text = normalize_ws(cell)
                        if not text:
                            continue
                        if re.search(r"셀\s*\(", text):
                            continue
                        image_cell = image_cells[column_index] if column_index < len(image_cells) else None
                        page_slots.append((parse_person_label(text), image_for_cell(page.images, image_cell)))
            else:
                for row in table[2:]:
                    for cell in row:
                        text = normalize_ws(cell)
                        if not text:
                            continue
                        if re.search(r"셀\s*\(", text):
                            continue
                        page_slots.append((parse_person_label(text), None))

            for person, image in page_slots:
                if not person["name"]:
                    continue
                member_id = f"seed-{len(members) + 1:03d}"
                photo_url = ""
                photo_key = ""
                if image:
                    data = image["stream"].get_data()
                    photo_path = PHOTO_DIR / f"{member_id}.jpg"
                    photo_path.write_bytes(data)
                    photo_url = f"photos/{member_id}.jpg?v={PHOTO_VERSION}"
                    photo_key = f"{R2_SEED_PHOTO_PREFIX}{member_id}.jpg"
                members.append({
                    "id": member_id,
                    "cellId": current_cell_id,
                    "cellName": current_cell_name,
                    "name": person["name"],
                    "title": person["title"],
                    "role": person["role"],
                    "phone": "",
                    "homePhone": "",
                    "birth": "",
                    "registeredAt": "",
                    "baptized": True,
                    "address": "",
                    "memo": "",
                    "prayerRequests": "",
                    "longAbsent": False,
                    "photoUrl": photo_url,
                    "photoKey": photo_key,
                    "photoRemoved": not bool(photo_url),
                    "archivedAt": "",
                    "trashedAt": "",
                    "createdAt": "2026-07-08T00:00:00.000Z",
                    "updatedAt": "2026-07-08T00:00:00.000Z",
                    "page": page_index,
                })

    for member in members:
        member.pop("page", None)
    return cells, members


def parse_excel_identity(text):
    match = re.search(r"이름\s*\(직분\)\s+(.+?)\s+(?:배우자|신앙세대주|생년월일)", text)
    identity = normalize_ws(match.group(1) if match else "")
    identity = re.sub(r"\s*[남여]\s*$", "", identity).strip()
    name = identity
    title = ""
    title_match = re.search(r"^(.+?)\s*\(([^)]*)\)", identity)
    if title_match:
        name = normalize_ws(title_match.group(1))
        title_text = normalize_ws(title_match.group(2))
        for word in TITLE_WORDS:
            if word in title_text:
                title = word
                break
        if not title:
            title = title_text
    name = re.sub(r"(?<=[가-힣])\d{2}$", "", name).strip()
    return name, title


def between(text, start, end):
    pattern = re.escape(start) + r"\s*(.*?)\s*" + re.escape(end)
    match = re.search(pattern, text)
    return normalize_ws(match.group(1) if match else "")


def clean_address(value):
    text = normalize_ws(value)
    if not text:
        return ""
    parts = re.split(r"(?=(?:충남|충청남도|서울|경기|경기도|대전|세종|전북|전라북도|부산|대구|인천|광주|울산|강원|제주)\s)", text)
    cleaned = []
    for part in parts:
        part = normalize_ws(part)
        if part and part not in cleaned:
            cleaned.append(part)
    return " / ".join(cleaned) if cleaned else text


def parse_profile_excel():
    main = pd.read_html(PROFILE_XLS, encoding="utf-8")[0]
    profiles = {}
    for _, row in main.iloc[1:].iterrows():
        text = normalize_ws(row.iloc[1])
        if not text or text == "nan":
            continue
        name, title = parse_excel_identity(text)
        zone_match = re.search(r"구역\s+오세아니아\s*>\s*([남여])\s*(\d+)\s*셀", text)
        if not name:
            continue
        current_cell_id = ""
        if zone_match:
            zone_label = f"{'남자' if zone_match.group(1) == '남' else '여자'} {int(zone_match.group(2))}셀"
            current_cell_id = cell_id(zone_label)

        birth = ""
        birth_match = re.search(r"생년월일\s*\(나이\)\s+(\d{4}-\d{2}-\d{2})(?:\s*([양음?]))?\s*\((\d+세)\)", text)
        if birth_match:
            marker = "" if birth_match.group(2) == "?" else normalize_ws(birth_match.group(2))
            birth = " ".join(part for part in [birth_match.group(1), marker, f"({birth_match.group(3)})"] if part)

        registered_at = ""
        registered_match = re.search(r"등록일\s+(\d{4}-\d{2}-\d{2})", text)
        if registered_match:
            registered_at = registered_match.group(1)

        contact_text = between(text, "연락처", "인도자")
        phones = re.findall(r"0\d{1,2}-\d{3,4}-\d{4}", contact_text)
        mobile = ""
        home = ""
        for phone in phones:
            if re.match(r"01[016789]-", phone) and not mobile:
                mobile = phone
            elif not home:
                home = phone
        if not mobile and phones:
            mobile = phones[0]
            home = phones[1] if len(phones) > 1 else ""

        address_match = re.search(r"주소\s+(.*?)\s+최종수정일", text)
        address = clean_address(address_match.group(1) if address_match else "")

        spouse = between(text, "배우자", "신앙세대주")
        household = between(text, "신앙세대주", "생년월일")
        memo_lines = []
        if spouse and spouse.lower() != "nan":
            memo_lines.append(f"배우자: {spouse}")
        if household and household != f"{name} 의 본인":
            memo_lines.append(f"신앙세대주: {household}")

        key = (current_cell_id, compact(name))
        profiles.setdefault(key, []).append({
            "excelName": name,
            "excelTitle": title,
            "phone": mobile,
            "homePhone": home,
            "birth": birth,
            "registeredAt": registered_at,
            "address": address,
            "memo": "\n".join(memo_lines),
        })
    return profiles


def merge_profiles(members, profiles):
    matched = 0
    review = []
    by_name = {}
    for (profile_cell_id, profile_name), rows in profiles.items():
        by_name.setdefault(profile_name, []).extend(rows)
    for member in members:
        candidates = profiles.get((member["cellId"], compact(member["name"])), [])
        if not candidates:
            name_candidates = by_name.get(compact(member["name"]), [])
            if len(name_candidates) == 1:
                candidates = name_candidates
        if not candidates:
            review.append({"memberId": member["id"], "name": member["name"], "cellId": member["cellId"], "reason": "no-profile-match"})
            continue
        if len(candidates) > 1:
            title_matches = [item for item in candidates if item.get("excelTitle") == member.get("title")]
            if len(title_matches) == 1:
                candidates = title_matches
            else:
                review.append({"memberId": member["id"], "name": member["name"], "cellId": member["cellId"], "reason": "ambiguous-profile-match"})
                continue
        profile = candidates[0]
        for key in ["phone", "homePhone", "birth", "registeredAt", "address", "memo"]:
            member[key] = profile.get(key, "") or member.get(key, "")
        matched += 1
    return matched, review


def write_members_json(cells, members):
    payload = {
        "results": [
            {
                **member,
                "cellName": next((cell["name"] for cell in cells if cell["id"] == member["cellId"]), member["cellId"]),
            }
            for member in members
        ]
    }
    path = OUT_DIR / "members.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def docx_to_text(path):
    document = Document(path)
    lines = [paragraph.text for paragraph in document.paragraphs]
    output = OUT_DIR / "visit-doc.txt"
    output.write_text("\n".join(lines), encoding="utf-8")
    return output


def run_helper(script_name, *args):
    script = ROOT / "scripts" / script_name
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    result = subprocess.run(
        [str(PYTHON), str(script), *map(str, args)],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=env,
    )
    return json.loads(result.stdout)


def load_ready_visit_rows(csv_path):
    rows = []
    with Path(csv_path).open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            if row.get("status") != "ready":
                continue
            rows.append({
                "id": row["visitId"],
                "memberId": row["memberId"],
                "visitDate": row["visitDate"],
                "visitType": row["visitType"] or "전화",
                "summary": row["summary"],
                "prayer": row.get("prayer", ""),
                "action": "",
                "source": row.get("source", "summary-visit-doc"),
                "rawPayload": row.get("rawPayload", ""),
                "createdAt": row.get("createdAt") or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            })
    return rows


def apply_prayer_preview(members, csv_path):
    member_by_id = {member["id"]: member for member in members}
    ready = 0
    review = 0
    with Path(csv_path).open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            if row.get("status") != "ready":
                review += 1
                continue
            member = member_by_id.get(row.get("memberId"))
            if not member:
                review += 1
                continue
            prayer = normalize_ws(row.get("prayerRequests", "")).replace(". ", ".\n")
            member["prayerRequests"] = prayer
            ready += 1
    return ready, review


def sql_quote(value):
    return "'" + str(value or "").replace("'", "''") + "'"


def write_private_sql(cells, members, visits):
    sql_path = OUT_DIR / "oceania-private-import.sql"
    lines = [
        "-- Private local import generated from source pastoral documents.",
        "-- Do not commit this file.",
        "DELETE FROM visit_notes;",
        "DELETE FROM members;",
        "DELETE FROM cells;",
    ]
    for cell in cells:
        lines.append(
            "INSERT OR REPLACE INTO cells (id, name, meta, gender, sort_order) VALUES "
            f"({sql_quote(cell['id'])}, {sql_quote(cell['name'])}, {sql_quote(cell['meta'])}, {sql_quote(cell['gender'])}, {int(cell['sortOrder'])});"
        )
    for member in members:
        values = [
            member["id"], member["cellId"], member["name"], member["title"], member["role"],
            member["phone"], member["homePhone"], member["birth"], member["registeredAt"],
            member["address"], member["memo"], member["prayerRequests"], 1 if member["baptized"] else 0,
            1 if member["longAbsent"] else 0, member["photoKey"], member["archivedAt"], member["trashedAt"],
            member["createdAt"], member["updatedAt"],
        ]
        lines.append(
            "INSERT OR REPLACE INTO members "
            "(id, cell_id, name, title, role, phone, home_phone, birth, registered_at, address, memo, prayer_requests, baptized, long_absent, photo_key, archived_at, trashed_at, created_at, updated_at) "
            f"VALUES ({', '.join(sql_quote(value) for value in values)});"
        )
    for visit in visits:
        values = [
            visit["id"], visit["memberId"], visit["visitDate"], visit["visitType"], visit["summary"],
            visit["prayer"], visit["action"], visit["source"], visit.get("rawPayload", ""), visit["createdAt"],
        ]
        lines.append(
            "INSERT OR IGNORE INTO visit_notes "
            "(id, member_id, visit_date, visit_type, summary, prayer, action, source, raw_payload, created_at) "
            f"VALUES ({', '.join(sql_quote(value) for value in values)});"
        )
    sql_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return sql_path


def write_private_js(cells, members, visits):
    public_members = []
    for member in members:
        item = {key: member[key] for key in [
            "id", "cellId", "name", "title", "role", "phone", "homePhone", "birth",
            "registeredAt", "baptized", "address", "memo", "prayerRequests", "longAbsent",
            "photoUrl", "photoKey", "photoRemoved", "archivedAt", "trashedAt", "createdAt", "updatedAt",
        ]}
        public_members.append(item)

    payload = {
        "version": DATA_VERSION,
        "communityTitle": COMMUNITY_TITLE,
        "cells": cells,
        "members": public_members,
        "visits": visits,
    }
    PRIVATE_JS.write_text(
        "window.MEMBER_DETAILS_VERSION = " + json.dumps(DATA_VERSION, ensure_ascii=False) + ";\n"
        "window.PRIVATE_COMMUNITY_TITLE = " + json.dumps(COMMUNITY_TITLE, ensure_ascii=False) + ";\n"
        "window.PRIVATE_PHOTO_VERSION = " + json.dumps(PHOTO_VERSION, ensure_ascii=False) + ";\n"
        "window.PRIVATE_INITIAL_CELLS = " + json.dumps(cells, ensure_ascii=False, indent=2) + ";\n"
        "window.PRIVATE_INITIAL_MEMBERS = " + json.dumps(public_members, ensure_ascii=False, indent=2) + ";\n"
        "window.INITIAL_VISITS = " + json.dumps(visits, ensure_ascii=False, indent=2) + ";\n"
        "window.MEMBER_DETAILS = window.MEMBER_DETAILS || {};\n",
        encoding="utf-8",
    )
    data_path = OUT_DIR / "private-data.json"
    data_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return data_path


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for path in [PHOTO_PDF, PROFILE_XLS, VISIT_DOCX, PRAYER_PDF]:
        if not path.exists():
            raise FileNotFoundError(path)

    cells, members = parse_roster()
    profile_match_count, profile_review = merge_profiles(members, parse_profile_excel())
    members_json = write_members_json(cells, members)

    prayer_result = run_helper("prepare_prayer_requests_import.py", PRAYER_PDF, members_json, OUT_DIR)
    prayer_ready, prayer_review = apply_prayer_preview(members, prayer_result["csv"])
    members_json = write_members_json(cells, members)

    visit_text = docx_to_text(VISIT_DOCX)
    visit_csv = OUT_DIR / "visit-import-preview.csv"
    visit_sql = OUT_DIR / "visit-import.sql"
    visit_result = run_helper("prepare_visit_import.py", visit_text, members_json, visit_csv, visit_sql)
    visits = load_ready_visit_rows(visit_csv)

    sql_path = write_private_sql(cells, members, visits)
    data_path = write_private_js(cells, members, visits)

    summary = {
        "cells": len(cells),
        "members": len(members),
        "profileMatched": profile_match_count,
        "profileReview": profile_review,
        "prayerReady": prayer_ready,
        "prayerReview": prayer_review,
        "visitReady": len(visits),
        "visitSourceEntries": visit_result.get("entries"),
        "outputs": {
            "privateJs": str(PRIVATE_JS),
            "photos": str(PHOTO_DIR),
            "privateDataJson": str(data_path),
            "privateSql": str(sql_path),
            "membersJson": str(members_json),
            "prayerCsv": prayer_result["csv"],
            "visitCsv": str(visit_csv),
        },
    }
    (OUT_DIR / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
