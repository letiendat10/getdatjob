// USMCA TN visa — approved professions mapped to job title keywords.
// Source: 8 CFR § 214.6(c), Appendix 1603.D.1 of USMCA.
// Category order matters: more specific entries checked before broad ones (e.g. "Landscape Architect" before "Architect").

export type TnCategory = {
  name: string;
  keywords: string[];  // lowercase substrings matched against job title
};

export const TN_CATEGORIES: TnCategory[] = [
  // Computer Systems Analyst — broadly interpreted by CBP to include software roles
  {
    name: "Computer Systems Analyst",
    keywords: [
      "software engineer", "software developer", "software architect",
      "systems analyst", "computer scientist", "programmer",
      "data engineer", "data scientist", "machine learning", "ml engineer",
      "ai engineer", "llm engineer", "full stack", "fullstack",
      "frontend engineer", "backend engineer", "mobile engineer",
      "ios engineer", "android engineer", "devops engineer", "cloud engineer",
      "security engineer", "platform engineer", "site reliability",
      "solutions architect", "technical architect", "systems engineer",
    ],
  },
  // Landscape Architect must come before Architect to avoid over-broad match
  { name: "Landscape Architect",      keywords: ["landscape architect"] },
  { name: "Architect",                keywords: ["architect"] },
  { name: "Engineer",                 keywords: ["engineer"] },
  { name: "Accountant",               keywords: ["accountant", "cpa ", " cpa", "controller", "auditor"] },
  { name: "Economist",                keywords: ["economist"] },
  { name: "Mathematician / Statistician", keywords: ["mathematician", "statistician", "quantitative analyst", "quant analyst"] },
  { name: "Graphic Designer",         keywords: ["graphic designer"] },
  { name: "Industrial Designer",      keywords: ["industrial designer"] },
  { name: "Interior Designer",        keywords: ["interior designer"] },
  { name: "Land Surveyor",            keywords: ["land surveyor", "survey"] },
  { name: "Lawyer",                   keywords: ["lawyer", "attorney", " counsel", "solicitor"] },
  { name: "Librarian",                keywords: ["librarian"] },
  { name: "Management Consultant",    keywords: ["management consultant"] },
  { name: "Range Manager",            keywords: ["range manager", "range conservationist"] },
  { name: "Social Worker",            keywords: ["social worker"] },
  { name: "Technical Publications Writer", keywords: ["technical writer", "technical publications"] },
  { name: "Urban Planner / Geographer",    keywords: ["urban planner", "city planner", "geographer"] },
  { name: "Vocational Counselor",     keywords: ["vocational counselor"] },
  // Medical / Allied Health
  { name: "Dentist",                  keywords: ["dentist"] },
  { name: "Dietitian / Nutritionist", keywords: ["dietitian", "nutritionist"] },
  { name: "Medical Technologist",     keywords: ["medical technologist"] },
  { name: "Nurse / RN",               keywords: ["registered nurse", " rn,", "nurse practitioner", " np,", "nursing"] },
  { name: "Occupational Therapist",   keywords: ["occupational therapist"] },
  { name: "Pharmacist",               keywords: ["pharmacist"] },
  { name: "Physician",                keywords: ["physician", "doctor of medicine"] },
  { name: "Physical Therapist",       keywords: ["physical therapist", "physiotherapist"] },
  { name: "Psychologist",             keywords: ["psychologist"] },
  { name: "Recreational Therapist",   keywords: ["recreational therapist"] },
  { name: "Veterinarian",             keywords: ["veterinarian"] },
  // Scientists
  { name: "Agricultural Scientist",   keywords: ["agricultural scientist"] },
  { name: "Astronomer",               keywords: ["astronomer"] },
  { name: "Biologist",                keywords: ["biologist"] },
  { name: "Chemist",                  keywords: ["chemist"] },
  { name: "Dairy Scientist",          keywords: ["dairy scientist"] },
  { name: "Entomologist",             keywords: ["entomologist"] },
  { name: "Epidemiologist",           keywords: ["epidemiologist"] },
  { name: "Geneticist",               keywords: ["geneticist"] },
  { name: "Geochemist",               keywords: ["geochemist"] },
  { name: "Geologist",                keywords: ["geologist"] },
  { name: "Geophysicist",             keywords: ["geophysicist"] },
  { name: "Horticulturalist",         keywords: ["horticulturalist", "horticulturist"] },
  { name: "Meteorologist",            keywords: ["meteorologist"] },
  { name: "Oceanographer",            keywords: ["oceanographer"] },
  { name: "Physicist",                keywords: ["physicist"] },
  { name: "Plant Breeder",            keywords: ["plant breeder"] },
  { name: "Soil Scientist",           keywords: ["soil scientist"] },
  { name: "Zoologist",                keywords: ["zoologist"] },
  // Teachers (post-secondary only)
  { name: "University / College Teacher", keywords: ["professor", "lecturer", "faculty"] },
];

// Returns the matching TN profession name, or null if not TN-eligible.
export function getTnCategory(title: string): string | null {
  const lower = title.toLowerCase();
  for (const cat of TN_CATEGORIES) {
    if (cat.keywords.some((kw) => lower.includes(kw))) return cat.name;
  }
  return null;
}

export function isTnEligible(title: string): boolean {
  return getTnCategory(title) !== null;
}

// Flat deduplicated keyword list for server-side DB ILIKE filtering.
export const TN_TITLE_KEYWORDS: string[] = [
  ...new Set(TN_CATEGORIES.flatMap((c) => c.keywords)),
];
