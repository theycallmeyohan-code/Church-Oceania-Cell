import csv
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import pdfplumber
from pypdf import PdfReader


TITLE_RE = re.compile(r"([가-힣]{2,5})(장로|권사|집사B?|집사|성도)")
EXACT_NAME_RE = re.compile(r"^([가-힣]{2,5})(장로|권사|집사B?|집사|성도)$")
CELL_RE = re.compile(r"(남자|여자)\s*(\d+)셀")
CELL_LABELS = {
    "male-8": "남자 8셀",
    "male-16": "남자 16셀",
    "female-3": "여자 3셀",
    "female-9": "여자 9셀",
    "female-15": "여자 15셀",
    "female-25": "여자 25셀",
    "female-33": "여자 33셀",
}


def normalize_ws(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def clean_prayer(value):
    text = str(value or "").replace("\r\n", "\n").replace("\r", "\n")
    text = normalize_ws(text)
    text = re.sub(r"\s+([,.)\]])", r"\1", text)
    text = re.sub(r"([(\[])\s+", r"\1", text)
    return text


def compact(value):
    return re.sub(r"\s+", "", str(value or ""))


def sql_quote(value):
    return "'" + str(value or "").replace("'", "''") + "'"


def load_members(path):
    payload = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    rows = payload[0]["results"] if isinstance(payload, list) else payload["results"]
    return [
        row
        for row in rows
        if not row.get("trashedAt") and not row.get("archivedAt")
    ]


def cell_id_from_text(text):
    match = CELL_RE.search(text or "")
    if not match:
        return ""
    prefix = "male" if match.group(1) == "남자" else "female"
    return f"{prefix}-{int(match.group(2))}"


def split_name_title(raw_name):
    raw = compact(raw_name)
    exact = EXACT_NAME_RE.match(raw)
    if exact:
        return exact.group(1), exact.group(2)
    found = TITLE_RE.search(raw)
    if found:
        return found.group(1), found.group(2)
    return raw, ""


def remove_name_token(text, name, title):
    output = text or ""
    for token in [f"{name}{title}", f"{name}집사", f"{name}권사", f"{name}장로", f"{name}성도", name]:
        output = output.replace(token, " ")
    return clean_prayer(output)


def find_member_in_text(members_by_cell, cell_id, text):
    text_compact = compact(text)
    matches = []
    for member in members_by_cell.get(cell_id, []):
        title = member.get("title") or ""
        tokens = [f"{member['name']}{title}", member["name"]]
        for token in tokens:
            token_compact = compact(token)
            if token_compact and token_compact in text_compact:
                matches.append((text_compact.find(token_compact), member))
                break
    if not matches:
        return None
    return sorted(matches, key=lambda item: item[0])[-1][1]


def extract_entries(pdf_path, members):
    members_by_cell = {}
    for member in members:
        members_by_cell.setdefault(member["cellId"], []).append(member)

    entries = []
    current_cell_id = ""
    current = None

    with pdfplumber.open(pdf_path) as pdf:
        for page_no, page in enumerate(pdf.pages, 1):
            page_text = page.extract_text() or ""
            page_cell_id = cell_id_from_text(page_text)
            if page_cell_id:
                current_cell_id = page_cell_id

            for table in page.extract_tables() or []:
                for row in table:
                    if not row:
                        continue
                    row = list(row) + ["", "", ""]
                    no = normalize_ws(row[0])
                    name_cell = clean_prayer(row[1])
                    prayer_cell = clean_prayer(row[2])

                    if no == "번호":
                        continue

                    if re.fullmatch(r"\d+", no):
                        current = {
                            "page": page_no,
                            "cellId": current_cell_id,
                            "cellName": CELL_LABELS.get(current_cell_id, current_cell_id),
                            "no": int(no),
                            "rawName": name_cell,
                            "name": "",
                            "pdfTitle": "",
                            "prayer": "",
                        }
                        combined = clean_prayer("\n".join(part for part in row[1:3] if part))

                        if current_cell_id == "male-8" and current["no"] == 16:
                            current["rawName"] = "최한필집사"
                            current["name"] = "최한필"
                            current["pdfTitle"] = "집사"
                            current["prayer"] = prayer_cell or remove_name_token(combined, "최한필", "집사")
                        else:
                            raw_for_name = name_cell
                            if not raw_for_name or len(compact(raw_for_name)) > 12 or not TITLE_RE.search(compact(raw_for_name)):
                                member = find_member_in_text(members_by_cell, current_cell_id, combined)
                                if member:
                                    raw_for_name = f"{member['name']}{member.get('title') or ''}"
                                    current["prayer"] = prayer_cell or remove_name_token(combined, member["name"], member.get("title") or "")

                            name, title = split_name_title(raw_for_name)
                            current["rawName"] = raw_for_name
                            current["name"] = name
                            current["pdfTitle"] = title
                            if not current["prayer"]:
                                current["prayer"] = prayer_cell

                        current["prayer"] = clean_prayer(current["prayer"])
                        entries.append(current)
                        continue

                    if current:
                        continuation = prayer_cell or name_cell
                        if continuation:
                            current["prayer"] = clean_prayer(f"{current['prayer']}\n{continuation}")

    return entries


def extract_continuous_entries(pdf_path):
    entries = {}
    current_cell_id = ""
    entry_re = re.compile(r"(\d{1,2})([가-힣]{2,5})(장로|권사|집사|성도)\s*\n")
    reader = PdfReader(pdf_path)

    for page in reader.pages:
        text = page.extract_text() or ""
        page_cell_id = cell_id_from_text(text)
        if page_cell_id:
            current_cell_id = page_cell_id

        special_male8_no16 = None
        if current_cell_id == "male-8":
            special_male8_no16 = re.search(r"(?<!\d)16\s*\n", text)

        matches = list(entry_re.finditer(text))
        for index, match in enumerate(matches):
            end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
            if special_male8_no16 and match.start() < special_male8_no16.start() < end:
                end = special_male8_no16.start()

            no = int(match.group(1))
            name = match.group(2)
            prayer = clean_prayer(text[match.end():end])
            entries[(current_cell_id, no, name)] = prayer
            entries.setdefault((current_cell_id, name), prayer)

        if special_male8_no16:
            prayer = remove_name_token(clean_prayer(text[special_male8_no16.end():]), "최한필", "집사")
            entries[("male-8", 16, "최한필")] = prayer
            entries.setdefault(("male-8", "최한필"), prayer)

    return entries


def merge_continuous_text(entries, pdf_path):
    continuous_entries = extract_continuous_entries(pdf_path)
    for entry in entries:
        key = (entry["cellId"], entry["no"], entry["name"])
        fallback_key = (entry["cellId"], entry["name"])
        better_prayer = continuous_entries.get(key) or continuous_entries.get(fallback_key)
        if better_prayer:
            entry["prayer"] = better_prayer
        else:
            entry["prayer"] = clean_prayer(entry["prayer"])
    return entries


def resolve_entry(entry, members):
    if entry["cellId"] == "female-15" and entry["no"] == 16 and entry["name"] == "최경애":
        matches = [
            member
            for member in members
            if member["cellId"] == "female-9" and member["name"] == "최경애"
        ]
        if len(matches) == 1:
            return matches[0], "special:최경애-여자9셀"

    cell_members = [
        member
        for member in members
        if member["cellId"] == entry["cellId"] and member["name"] == entry["name"]
    ]

    if entry["cellId"] == "female-25" and entry["name"] == "김미숙":
        text = entry["prayer"]
        if "윤동현" in text:
            matches = [member for member in cell_members if member.get("role") == "prayer_leader"]
            if len(matches) == 1:
                return matches[0], "special:김미숙-윤동현"
        if "조성도" in text:
            matches = [member for member in cell_members if "B" in (member.get("title") or "")]
            if len(matches) == 1:
                return matches[0], "special:김미숙-조성도"
        return None, "ambiguous:김미숙"

    if len(cell_members) == 1:
        return cell_members[0], "cell+name"
    if not cell_members:
        return None, "no-match"
    return None, "ambiguous"


def write_outputs(entries, members, out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)

    rows = []
    review = []
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    for entry in entries:
        member, match_type = resolve_entry(entry, members)
        row = {
            "status": "ready" if member and entry["prayer"] else "review",
            "reason": "" if member and entry["prayer"] else (match_type if not member else "empty-prayer"),
            "memberId": member["id"] if member else "",
            "cellName": entry["cellName"],
            "pdfNo": entry["no"],
            "pdfName": entry["rawName"],
            "memberName": member["name"] if member else entry["name"],
            "memberTitle": member.get("title", "") if member else "",
            "matchType": match_type,
            "prayerRequests": entry["prayer"],
            "existingPrayerRequests": member.get("prayerRequests", "") if member else "",
        }
        if row["status"] == "ready":
            rows.append(row)
        else:
            review.append(row)

    ready = []
    ready_by_member = {}
    for row in rows:
        current = ready_by_member.get(row["memberId"])
        if not current:
            ready_by_member[row["memberId"]] = row
            ready.append(row)
            continue

        prayers = [current["prayerRequests"], row["prayerRequests"]]
        combined = "\n\n".join(prayer for prayer in prayers if prayer.strip())
        current["prayerRequests"] = combined
        current["pdfNo"] = f"{current['pdfNo']};{row['pdfNo']}"
        current["pdfName"] = f"{current['pdfName']};{row['pdfName']}"
        current["cellName"] = f"{current['cellName']};{row['cellName']}"
        current["matchType"] = f"{current['matchType']};{row['matchType']}"

    csv_path = out_dir / "prayer-requests-import-preview.csv"
    fields = [
        "status",
        "reason",
        "memberId",
        "cellName",
        "pdfNo",
        "pdfName",
        "memberName",
        "memberTitle",
        "matchType",
        "prayerRequests",
        "existingPrayerRequests",
    ]
    with csv_path.open("w", newline="", encoding="utf-8-sig") as file:
        writer = csv.DictWriter(file, fieldnames=fields)
        writer.writeheader()
        writer.writerows(ready)
        writer.writerows(review)

    sql_path = out_dir / "prayer-requests-import.sql"
    with sql_path.open("w", encoding="utf-8") as file:
        file.write("-- Generated by scripts/prepare_prayer_requests_import.py\n")
        for row in ready:
            file.write(
                "UPDATE members SET "
                f"prayer_requests = {sql_quote(row['prayerRequests'])}, "
                f"updated_at = {sql_quote(now)} "
                f"WHERE id = {sql_quote(row['memberId'])};\n"
            )

    return ready, review, csv_path, sql_path


def main():
    if len(sys.argv) != 4:
        print("Usage: prepare_prayer_requests_import.py <pdf> <members-json> <out-dir>", file=sys.stderr)
        return 2
    pdf_path = sys.argv[1]
    members_path = sys.argv[2]
    out_dir = Path(sys.argv[3])
    members = load_members(members_path)
    entries = merge_continuous_text(extract_entries(pdf_path, members), pdf_path)
    ready, review, csv_path, sql_path = write_outputs(entries, members, out_dir)
    print(json.dumps({
        "entries": len(entries),
        "ready": len(ready),
        "review": len(review),
        "csv": str(csv_path),
        "sql": str(sql_path),
        "reviewItems": [
            {
                "cellName": row["cellName"],
                "pdfNo": row["pdfNo"],
                "pdfName": row["pdfName"],
                "reason": row["reason"],
                "prayer": row["prayerRequests"][:120],
            }
            for row in review
        ],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
