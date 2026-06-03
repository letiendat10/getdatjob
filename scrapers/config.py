import os
import sys

SUPABASE_URL = "https://tdgptapfspleoobiyiqx.supabase.co"
# Service-role key comes from the environment ONLY — never commit it. CI provides it
# via the `SUPABASE_KEY` GitHub Actions secret; locally, export it (or source a .env).
# An absent GitHub secret renders the env var as an empty string, so guard against
# unset *and* empty with a clear message — otherwise create_client dies with an opaque
# "supabase_key is required".
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")
if not SUPABASE_KEY:
    sys.exit(
        "SUPABASE_KEY is not set. Configure the GitHub Actions secret "
        "(Settings -> Secrets -> Actions) and/or export SUPABASE_KEY locally "
        "before running scrapers."
    )

DATA_DIR = "/Users/dat/getdatjob/data"
LCA_FILE = f"{DATA_DIR}/raw/LCA_Dislclosure_Data_FY2026_Q2.xlsx"

TOP_N_EMPLOYERS = 2000
