"""
domain_resolve.py — shared brand-domain resolution for LCA intake (00 + 01).

`employers.company_domain_url` is the SINGLE source of truth for a company's brand
(logo) domain. It is derived from the LCA EMPLOYER_POC_EMAIL — but that email is often
a third-party immigration law firm (HP → hp@fragomen.com) or a SaaS/mail vendor
(Medline → globalmobility@medlinehr.zendesk.com). Storing those yields the wrong logo.

We do NOT blanket-blocklist these domains — a law firm can be a legitimate employer of
its own staff (the real Fragomen keeps fragomen.com). Instead:
  1. BRAND_DOMAIN_FIX  — curated email-domain → brand-domain remaps (confirmed fixes).
  2. law-firm/vendor   — when the employer is clearly NOT that brand, substitute a
                         best-guess name-derived domain and FLAG it for human review.
  3. otherwise         — use the email domain as-is.
"""

import re

# Free / personal providers — never a brand domain.
GENERIC_EMAIL_DOMAINS = {
    "gmail.com", "outlook.com", "yahoo.com", "hotmail.com", "icloud.com", "aol.com",
    "protonmail.com", "me.com", "live.com", "msn.com",
}

# Immigration law firms / agents that file LCAs for employers. A REVIEW TRIGGER,
# not a drop list: if the employer IS this firm (name match), the domain is kept.
LAWFIRM_DOMAINS = {
    "fragomen.com", "bal.com", "ogletree.com", "seyfarth.com", "jacksonlewis.com",
    "foley.com", "flwlaw.com", "immigrationlaw.com", "klaskolaw.com", "maggio-kattar.com",
    "hallrender.com", "lukebowmanlaw.com", "mvalaw.com", "chongwonlaw.com", "eiglaw.com",
    "gip-us.com", "kpmg.ca",
}

# Generic SaaS / mail hosts some employers route immigration mail through.
VENDOR_DOMAINS = {
    "zendesk.com", "sharepoint.com", "atlassian.net", "sendgrid.net", "mailchimp.com",
}

# Curated email-domain → brand-domain remaps. Encodes confirmed corrections so each
# intake reproduces them exactly (instead of a weak name guess). Keep 1:1 only — never
# map a domain shared by unrelated employers (e.g. squareup.com).
BRAND_DOMAIN_FIX = {
    "sofi.org": "sofi.com",
    "sci-us.com": "sci-corp.com",
    "wnco.com": "southwest.com",
    "coupanginc.com": "coupang.com",
    "nrd.nissan-usa.com": "nissanusa.com",
    "ny.email.gs.com": "gs.com",
    "lm.renesas.com": "renesas.com",
    "medlinehr.zendesk.com": "medline.com",
}

_SUFFIX_STOP = {
    "incorporated", "inc", "llc", "llp", "lp", "corporation", "corp", "limited", "ltd",
    "co", "company", "pbc", "pc", "pllc", "na", "opco", "the", "group", "holdings",
    "holding", "services", "service", "usa", "us",
}


def registrable(domain: str) -> str:
    """Last two labels (medlinehr.zendesk.com -> zendesk.com)."""
    parts = [p for p in domain.split(".") if p]
    return ".".join(parts[-2:]) if len(parts) >= 2 else domain


def name_stem(name: object) -> str:
    """Lowercased, suffix-stripped, alnum-only company stem."""
    s = re.sub(r"[^a-z0-9 ]", " ", str(name or "").lower())
    return "".join(t for t in s.split() if t and t not in _SUFFIX_STOP)


def name_derived_domain(name: object) -> "str | None":
    """Best-guess brand domain from a company name (review-only fallback)."""
    m = re.search(r"\b([a-z0-9-]+\.(com|org|net|io|co|ai))\b", str(name or "").lower())
    if m:
        return m.group(1)
    stem = name_stem(name)
    return stem + ".com" if stem else None


def resolve_company_domain(poc_email: object, employer_name: object) -> "tuple[str | None, bool, str]":
    """Resolve the brand (logo) domain. Returns (domain, needs_review, reason).

    (brand, False, "")        normal — store it
    (None,  False, reason)    generic provider / no email — store nothing
    (guess, True,  reason)    POC domain is a law firm/vendor and the employer is not
                              that brand — store the name guess but FLAG for review.
    """
    if not isinstance(poc_email, str) or "@" not in poc_email:
        return (None, False, "no poc email")
    dom = poc_email.lower().strip().split("@", 1)[1]
    if not dom:
        return (None, False, "no poc email")
    dom = BRAND_DOMAIN_FIX.get(dom, dom)
    reg = registrable(dom)
    if reg in GENERIC_EMAIL_DOMAINS:
        return (None, False, "generic email provider")
    if reg in LAWFIRM_DOMAINS or reg in VENDOR_DOMAINS:
        stem = name_stem(employer_name)
        brand = reg.split(".")[0]
        if brand and stem and (brand in stem or stem in brand):
            return (dom, False, "")  # employer IS the firm/vendor — keep
        kind = "law firm" if reg in LAWFIRM_DOMAINS else "vendor"
        return (name_derived_domain(employer_name), True, f"poc domain is a {kind} ({reg})")
    return (dom, False, "")
