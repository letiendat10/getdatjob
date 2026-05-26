"""
Dry-run ATS detection — no DB writes.
Tests slug candidates for all employers not yet in employer_ats.
Prints two lists: confirmed hits and no-match companies.
"""

import re
import time
import sys
import requests
from supabase import create_client
from config import SUPABASE_URL, SUPABASE_KEY

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

HEADERS = {"User-Agent": "getdatjob-bot/1.0"}
TIMEOUT = 8

# Known brand name → (ats_type, slug) for companies where auto-slugify won't work
SLUG_OVERRIDES = {
    # Big Tech — all use internal ATS, skip
    "amazon.com services":       None,
    "amazon web services":       None,
    "amazon development center": None,
    "amazon data services":      None,
    "amazon advertising":        None,
    "annapurna labs":            None,   # Amazon subsidiary
    "audible":                   None,   # Amazon subsidiary
    "microsoft corporation":     None,
    "apple inc":                 None,
    "linkedin corporation":      None,   # Microsoft-owned
    "tesla":                     None,   # internal ATS

    # Consulting / staffing — all internal ATS
    "ernst & young":             None,
    "cognizant":                 ("workday", "collaborative.wd1/AllOpenings"),   # tenant=collaborative
    "deloitte":                  None,
    "infosys":                   None,
    "tata consultancy":          ("greenhouse", "tcs"),
    "wipro":                     None,
    "accenture":                 None,
    "capgemini":                 None,
    "mphasis":                   None,
    "ltimindtree":               None,
    "hcl america":               None,
    "hcl global":                None,
    "kforce":                    None,
    "compunnel":                 None,
    "randstad":                  None,
    "tech mahindra":             None,
    "kpmg":                      None,
    "pricewaterhousecoopers":    None,
    "pwc us":                    None,
    "cgi technologies":          None,
    "ntt data":                  None,
    "genpact":                   None,
    "hexaware":                  None,
    "ust global":                None,
    "virtusa":                   None,
    "msr technology":            None,
    "v-soft consulting":         None,
    "grandison management":      None,
    "people tech group":         None,
    "coforge":                   None,
    "birlasoft":                 None,
    "persistent systems":        None,
    "atos syntel":               None,
    "globallogic":               None,
    "mastech digital":           None,
    "synechron":                 None,
    "perficient":                None,
    "innova solutions":          None,
    "slk america":               None,
    "kpit technologies":         None,
    "nagarro":                   None,
    "akkodis":                   None,
    "brillio":                   None,
    "infogain":                  None,
    "headstrong services":       None,
    "tiger analytics":           None,

    # Banks / financial — internal ATS
    "jpmorgan":                  None,
    "citibank":                  None,
    "citigroup":                 None,
    "morgan stanley":            None,
    "barclays":                  None,
    "bank of america":           None,
    "wells fargo":               None,
    "goldman sachs":             None,
    "ubs business":              None,
    "state street bank":         None,
    "u.s. bank":                 None,
    "bank of new york":          None,
    "northern trust":            None,
    "citizens financial":        None,
    "truist bank":               None,
    "navy federal":              None,
    "charles schwab":            None,
    "raymond james":             None,
    "pnc financial":             None,
    "blackrock financial":       None,
    "point72":                   None,
    "citadel americas services": None,
    "citadel securities":        None,
    "intercontinental exchange": None,
    "db global technology":      None,
    "sumitomo mitsui":           None,
    "new york life":             None,
    "city national bank":        None,
    "western alliance bank":     None,
    "zions bancorporation":      None,
    "ally bank":                 None,
    "lpl financial":             None,

    # Telecom / cable — internal ATS
    "at&t":                      None,
    "verizon":                   None,
    "t-mobile":                  None,
    "comcast":                   None,
    "charter communications":    None,
    "dish wireless":             None,
    "dish network":              None,

    # Healthcare / pharma / hospitals — usually internal
    "mayo clinic":               None,
    "johns hopkins":             None,
    "harvard university":        None,
    "fidelity technology":       None,
    "fidelity investments":      None,
    "optum services":            None,
    "unitedhealth":              None,
    "humana":                    None,
    "cigna":                     ("workday", "cigna.wd5/cignacareers"),
    "aetna":                     None,
    "cvs":                       None,
    "elevance health":           None,
    "caremark":                  None,
    "health care service corporation": None,

    # National labs / govt — internal
    "brookhaven national":       None,
    "ut-battelle":               None,
    "lawrence berkeley":         None,
    "uchicago argonne":          None,
    "national institutes of health": None,
    "battelle memorial":         None,

    # Auto / industrial — mostly internal
    "ford motor":                None,
    "general motors":            None,
    "fca us":                    None,  # Stellantis
    "deere & company":           None,
    "cummins":                   None,
    "caterpillar":               None,
    "rockwell collins":          None,
    "aecom":                     None,
    "burns & mcdonnell":         None,
    "motorola solutions":        ("workday", "motorolasolutions.wd5/Careers"),

    # Misc enterprise — mostly Workday/SAP
    "oracle america":            None,
    "sap america":               None,
    "sap labs":                  None,
    "ibm corporation":           None,
    "intel corporation":         None,
    "cisco systems":             None,
    "qualcomm technologies":     None,
    "qualcomm atheros":          None,
    "qualcomm innovation":       None,
    "wal-mart":                  None,
    "walmart":                   None,
    "target enterprise":         None,
    "home depot":                None,
    "best buy":                  None,
    "costco":                    None,
    "fedex":                     None,
    "federal express":           None,
    "j.b. hunt":                 None,
    "penske":                    None,
    "carnival corporation":      None,
    "delta air lines":           None,
    "american airlines":         None,
    "starbucks":                 None,

    # Universities — internal HR systems
    "university of michigan":    None,
    "university of florida":     None,
    "university of california":  None,
    "university of pittsburgh":  None,
    "university of wisconsin":   None,
    "university of iowa":        None,
    "university of minnesota":   None,
    "university of illinois":    None,
    "university of washington":  None,
    "university of utah":        None,
    "university of colorado":    None,
    "university of missouri":    None,
    "university of maryland":    None,
    "university of virginia":    None,
    "university of chicago":     None,
    "university of southern california": None,
    "university of arizona":     None,
    "university of alabama":     None,
    "university of miami":       None,
    "university of oklahoma":    None,
    "university of south florida": None,
    "university of massachusetts": None,
    "university of nebraska":    None,
    "university of north carolina": None,
    "university of rochester":   None,
    "university of texas":       None,
    "stanford":                  None,
    "leland stanford":           None,
    "yale university":           None,
    "columbia university":       None,
    "duke university":           None,
    "brown university":          None,
    "carnegie mellon":           None,
    "northwestern university":   None,
    "ohio state":                None,
    "michigan state":            None,
    "texas a&m":                 None,
    "georgia institute":         None,
    "purdue university":         None,
    "cornell university":        None,
    "princeton university":      None,
    "massachusetts institute of technology": None,
    "rutgers":                   None,
    "emory university":          None,
    "vanderbilt university":     None,
    "arizona state":             None,
    "virginia polytechnic":      None,
    "west virginia university":  None,
    "indiana university":        None,
    "case western":              None,
    "baylor college":            None,
    "tulane":                    None,
    "boston university":         None,
    "florida state":             None,
    "oregon state":              None,
    "texas tech":                None,
    "howard hughes medical":     None,
    "icahn school":              None,
    "weill cornell":             None,
    "nyu grossman":              None,
    "dana-farber":               None,
    "memorial sloan":            None,
    "children's hospital":       None,
    "cedars-sinai":              None,
    "brigham and women":         None,
    "cincinnati children":       None,
    "jackson laboratory":        None,
    "general hospital corporation": None,
    "methodist hospital":        None,
    "st. jude":                  None,
    "st jude":                   None,
    "northwell health":          None,
    "ut southwestern":           None,
    "embry-riddle":              None,
    "open avenues":              None,
    "harmony public schools":    None,
    "dallas independent":        None,
    "denver public schools":     None,
    "new york city department":  None,

    # Known brand/legal mismatches
    "google llc":                None,                                               # careers.google.com (custom)
    "meta platforms":            None,                                               # metacareers.com (custom Workday)
    "nvidia corporation":        ("workday", "nvidia.wd5/NVIDIAExternalCareerSite"),
    "salesforce":                ("workday", "salesforce.wd12/External_Career_Site"),
    "servicenow":                ("workday", "servicenow.wd5/External"),
    "palo alto networks":        ("workday", "paloaltonetworks.wd1/External"),
    "tiktok inc":                None,                                               # complex — let detect_workday_urls find
    "tiktok u.s. data":          None,
    "tiktok usds":               None,
    "bytedance":                 None,
    "adobe inc":                 ("workday", "adobe.wd5/AdobeExternalCareerSite"),
    "intuit inc":                ("workday", "intuit.wd1/Intuit_Careers"),
    "workday, inc":              ("workday", "workday.wd5/careers"),                # Workday runs on their own platform
    "autodesk":                  ("workday", "autodesk.wd1/Ext"),
    "fortinet":                  None,                                               # let detect_workday_urls find
    "kla corporation":           None,
    "lam research":              None,
    "arm, inc":                  None,                                               # ARM post-SoftBank, slug unknown
    "docusign inc":              None,                                               # went private with Vista Equity
    "docusign, inc":             None,
    "rivian automotive":         ("greenhouse", "rivian"),
    "rivian and volkswagen":     ("greenhouse", "rivian"),
    "axon enterprise":           ("greenhouse", "axon"),
    "wayfair":                   ("greenhouse", "wayfair"),
    "lucid usa":                 ("greenhouse", "lucidmotors"),
    "chewy, inc":                ("greenhouse", "chewy"),
    "akamai":                    None,                                               # may have moved to Workday
    "netapp":                    None,                                               # let detect_workday_urls find
    "zoom communications":       ("workday", "zoom.wd5/Careers"),
    "nike, inc":                 ("workday", "nike.wd3/External"),
    "crusoe energy":             ("greenhouse", "crusoe"),
    "credit karma":              ("greenhouse", "creditkarma"),
    "cadence design":            None,
    "pure storage":              ("greenhouse", "purestorage"),
    "citadel securities americas": ("greenhouse", "citadel"),
    "citadel americas services": ("greenhouse", "citadel"),
    "sony interactive":          ("greenhouse", "sonyinteractiveentertainment"),
    "applied intuition":         ("greenhouse", "appliedintuition"),
    "advanced micro devices":    None,
    "synopsys":                  None,
    "paypal, inc":               ("workday", "paypal.wd1/jobs"),
    "ebay inc":                  None,                                               # Workday via Phenom, jobsite unknown
    "f5, inc":                   ("workday", "ffive.wd5/f5jobs"),                   # tenant=ffive
    "visa technology":           ("greenhouse", "visa"),
    "visa u.s.a":                ("greenhouse", "visa"),
    "nordstrom":                 ("workday", "nordstrom.wd5/Nordstrom_Careers"),
    "applied materials":         ("workday", "amat.wd1/External"),
    "analog devices":            None,
    "marvell semiconductor":     ("greenhouse", "marvell"),
    "medtronic":                 ("workday", "medtronic.wd5/External"),
    "amgen inc":                 ("workday", "amgen.wd1/jobs"),
    "gilead sciences":           ("workday", "gilead.wd5/External"),
    "genentech":                 ("workday", "roche.wd3/external"),
    "vertex pharmaceuticals":    ("greenhouse", "vrtx"),
    "bristol-myers squibb":      ("workday", "bms.wd5/ExternalCareerSite"),
    "thermo fisher":             ("workday", "thermofisher.wd5/ThermoFisher"),
    "beckton, dickinson":        ("greenhouse", "bd"),
    "becton, dickinson":         ("greenhouse", "bd"),
    "intuitive surgical":        None,
    "boston scientific":         None,
    "asml us":                   None,                                               # let detect_workday_urls find asml.wd3/...
    "micron technology":         ("workday", "micron.wd1/External"),
    "hp inc":                    ("workday", "hp.wd5/ExternalCareerSite"),
    "hewlett packard enterprise": ("workday", "hpe.wd5/ExternalCareerSite"),
    "samsung electronics america": None,                                             # Samsung has own careers portal
    "capital one services":      ("workday", "capitalone.wd12/Capital_One"),
    "capital one, national":     ("workday", "capitalone.wd12/Capital_One"),
    "walmart associates":        ("workday", "walmart.wd5/WalmartExternal"),
    "expedia":                   ("workday", "expedia.wd108/search"),
    "wayfair llc":               ("greenhouse", "wayfair"),
    "ralph lauren":              ("greenhouse", "ralphlauren"),
    "fiserv solutions":          ("workday", "fiserv.wd5/EXT"),
    "starbucks coffee":          ("workday", "starbucks.wd5/Starbucks"),
    "samsung":                   None,
    "jpmorgan chase":            None,                                               # Oracle HCM, not Greenhouse
    "blackrock":                 ("greenhouse", "blackrock"),
    "zoom":                      ("workday", "zoom.wd5/Careers"),
    "ab inbev":                  ("greenhouse", "abinbev"),
    "eli lilly":                 ("workday", "lilly.wd5/LLY"),
    "paycom payroll":            ("greenhouse", "paycom"),
    "discover products":         ("greenhouse", "discover"),
    "abbvie":                    ("workday", "abbvie.wd1/external"),
    "cardinal health":           None,
    "mckesson":                  ("greenhouse", "mckesson"),
    "equifax":                   ("greenhouse", "equifax"),
    "experian":                  ("greenhouse", "experian"),
    "fis management":            ("greenhouse", "fisglobal"),
    "worldpay":                  ("greenhouse", "worldpay"),
    "global payment":            ("greenhouse", "globalpayments"),
    "lowe's":                    ("greenhouse", "lowes"),
    "rocket mortgage":           ("greenhouse", "rocketmortgage"),
    "geico":                     ("greenhouse", "geico"),
    "toyota material":           ("greenhouse", "toyota"),
    "nokia of america":          ("greenhouse", "nokia"),
    "abb":                       ("greenhouse", "abb"),
    "maplebear":                 ("greenhouse", "instacart"),
    "social finance":            ("greenhouse", "sofi"),
    "slalom":                    ("greenhouse", "slalom"),
    "asurion":                   ("greenhouse", "asurion"),
    "exlservice":                ("greenhouse", "exl"),
    "mckinsey":                  ("greenhouse", "mckinsey"),
    "boston consulting":         ("greenhouse", "bcg"),
    "snowflake inc":             ("ashby", "snowflake"),
    "openai":                    ("ashby", "openai"),
    "yahoo holdings":            ("workday", "ouryahoo.wd5/careers"),               # tenant=ouryahoo
    "medline industries":        ("workday", "medline.wd5/Medline"),
    "zs associates":             ("greenhouse", "zs"),
    "citrix":                    None,                                               # acquired by Cloud Software Group
    "zendesk":                   None,                                               # went private
}


def slugify(name: str) -> list[str]:
    """Generate candidate slugs from company name."""
    base = re.sub(r"[^\w\s-]", "", name.lower())
    base = re.sub(r"[\s_]+", "-", base.strip())
    cleaned = re.sub(r"-(inc|llc|corp|ltd|co|group|technologies|technology|labs|ai|us|usa|lp|plc|pbc|llp|na|nv)$", "", base)
    words = [w for w in cleaned.split("-") if w not in ("the", "of", "and", "at")]
    first_word = words[0] if words else cleaned
    first_two = "-".join(words[:2]) if len(words) >= 2 else cleaned
    no_hyphen = "".join(words)
    candidates = list(dict.fromkeys([base, cleaned, first_word, first_two, no_hyphen]))
    return [c for c in candidates if c]


def check_greenhouse(slug: str) -> bool:
    url = f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs"
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        return r.status_code == 200 and "jobs" in r.json()
    except Exception:
        return False


def check_lever(slug: str) -> bool:
    url = f"https://api.lever.co/v0/postings/{slug}?mode=json"
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        return r.status_code == 200 and isinstance(r.json(), list)
    except Exception:
        return False


def check_ashby(slug: str) -> bool:
    url = f"https://jobs.ashby.com/api/posting-api/job-board?organizationHostedJobsPageName={slug}"
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        return r.status_code == 200 and "jobPostings" in r.json()
    except Exception:
        return False


ATS_CHECKS = [
    ("greenhouse", check_greenhouse, "https://boards.greenhouse.io/{}"),
    ("lever", check_lever, "https://jobs.lever.co/{}"),
    ("ashby", check_ashby, "https://jobs.ashby.com/{}"),
]


def find_override(name: str):
    """Check SLUG_OVERRIDES for a substring match."""
    lower = name.lower()
    for key, val in SLUG_OVERRIDES.items():
        if key in lower:
            return val  # None = skip, tuple = (ats_type, slug)
    return "NOT_FOUND"  # sentinel: no override, proceed with auto-detect


def detect(name: str):
    """Returns (ats_type, slug, url) or None."""
    override = find_override(name)
    if override == "NOT_FOUND":
        # Auto-detect via HTTP
        for slug in slugify(name):
            for ats_type, checker, url_fmt in ATS_CHECKS:
                if checker(slug):
                    return (ats_type, slug, url_fmt.format(slug))
                time.sleep(0.2)
        return None
    elif override is None:
        return None  # explicitly skipped
    else:
        ats_type, slug = override
        # Verify the override actually resolves
        for at, checker, url_fmt in ATS_CHECKS:
            if at == ats_type and checker(slug):
                return (ats_type, slug, url_fmt.format(slug))
        # Override didn't resolve — fall through to auto-detect
        for slug_c in slugify(name):
            for at, checker, url_fmt in ATS_CHECKS:
                if checker(slug_c):
                    return (at, slug_c, url_fmt.format(slug_c))
                time.sleep(0.2)
        return None


if __name__ == "__main__":
    employers = sb.table("employers").select("id,name,lca_count").execute().data
    existing = {r["employer_id"] for r in sb.table("employer_ats").select("employer_id").execute().data}
    to_check = [e for e in employers if e["id"] not in existing]
    to_check.sort(key=lambda x: x["lca_count"], reverse=True)

    print(f"Checking {len(to_check)} employers (skipping {len(existing)} already mapped)\n")

    hits = []
    skipped = []
    no_match = []

    for i, emp in enumerate(to_check):
        name = emp["name"]
        override = find_override(name)

        if override is None:
            skipped.append(name)
            print(f"  [{i+1}/{len(to_check)}] SKIP  {name}", flush=True)
            continue

        result = detect(name)
        if result:
            ats_type, slug, url = result
            hits.append((emp["id"], name, ats_type, slug, url))
            print(f"  [{i+1}/{len(to_check)}] FOUND {name} → {ats_type}:{slug}", flush=True)
        else:
            no_match.append(name)
            print(f"  [{i+1}/{len(to_check)}] MISS  {name}", flush=True)

        time.sleep(0.3)

    print("\n" + "="*70)
    print(f"CONFIRMED HITS ({len(hits)})")
    print("="*70)
    for emp_id, name, ats_type, slug, url in hits:
        print(f"  {name}")
        print(f"    {ats_type} | {url}")

    print("\n" + "="*70)
    print(f"NO ATS FOUND ({len(no_match)}) — review manually or skip")
    print("="*70)
    for name in no_match:
        print(f"  {name}")

    print(f"\nSkipped (internal ATS): {len(skipped)}")
    print(f"Total hits: {len(hits)}")
