"""
fix_workday_urls.py
One-time migration: Workday job URLs were stored without the jobsite path segment.

Bad:  https://adobe.wd5.myworkdayjobs.com/job/San-Francisco/Title_R123456
Good: https://adobe.wd5.myworkdayjobs.com/external_experienced/job/San-Francisco/Title_R123456

The jobsite is the part after '/' in the employer_ats slug (e.g., 'adobe.wd5/external_experienced').
"""

from supabase import create_client
from config import SUPABASE_URL, SUPABASE_KEY

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

# Get all Workday employer slugs
ats_rows = (
    sb.table("employer_ats")
    .select("employer_id,slug")
    .eq("ats_type", "workday")
    .execute()
    .data
)

total_updated = 0

for mapping in ats_rows:
    emp_id = mapping["employer_id"]
    slug = mapping["slug"]
    host, jobsite = slug.split("/", 1)
    base_url = f"https://{host}.myworkdayjobs.com"
    bad_prefix = f"{base_url}/job/"
    good_prefix = f"{base_url}/{jobsite}/job/"

    # Fetch all active Workday jobs for this employer with the broken URL pattern
    rows = (
        sb.table("jobs")
        .select("id,url,ats_job_id")
        .eq("employer_id", emp_id)
        .eq("ats_source", "workday")
        .like("url", f"{bad_prefix}%")
        .execute()
        .data
    )

    if not rows:
        print(f"  {slug}: no broken URLs found, skipping")
        continue

    updates = []
    for row in rows:
        correct_url = f"{base_url}/{jobsite}{row['ats_job_id']}"
        updates.append({"id": row["id"], "url": correct_url})

    # Update in batches of 500
    for i in range(0, len(updates), 500):
        batch = updates[i:i+500]
        for u in batch:
            sb.table("jobs").update({"url": u["url"]}).eq("id", u["id"]).execute()

    total_updated += len(updates)
    print(f"  {slug}: fixed {len(updates)} URLs")

print(f"\nDone. {total_updated} Workday job URLs updated.")
