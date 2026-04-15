// Scenarios based on the CDISC Pilot Study (CDISCPILOT01)
// — the canonical open-source clinical trial dataset published by CDISC.
// Source: https://github.com/cdisc-org/sdtm-adam-pilot-project

export const SCENARIOS = [
  {
    id: "ae-headache",
    title: "Adverse Event: Headache",
    subtitle: "A treatment-emergent headache mapped to the AE domain",
    domain: "AE",
    domainName: "Adverse Events",
    difficulty: "Beginner",
    icon: "⚠️",

    story: {
      title: "The Patient Event",
      patient: { id: "01-701-1015", age: 63, sex: "Female", arm: "Placebo" },
      narrative:
        "Three days after starting treatment in the Xanomeline Alzheimer's study, Subject 1015 (a 63-year-old woman) reports a headache to the study nurse. She describes it as mild — bothersome but not preventing daily activities. The investigator records it and assesses it as possibly related to the study drug. The headache resolves on its own after 3 days, and her study drug dose is not changed.",
      keyFacts: [
        { label: "What happened", value: "Headache" },
        { label: "When", value: "Day 3 of treatment (Jan 6, 2014)" },
        { label: "Severity", value: "Mild" },
        { label: "Duration", value: "3 days (resolved Jan 9)" },
        { label: "Action taken", value: "None — dose unchanged" },
        { label: "Causality", value: "Possibly related to study drug" },
      ],
    },

    crf: {
      title: "Adverse Event Case Report Form",
      description:
        "This is what the investigator fills out when a patient reports an adverse event. Every field has a regulatory purpose.",
      fields: [
        { label: "Adverse Event Term", value: "Headache", why: "Captured verbatim — exactly what the patient reported, in the investigator's words" },
        { label: "Start Date", value: "06-JAN-2014", why: "When the AE began — critical for determining if it's treatment-emergent" },
        { label: "End Date", value: "09-JAN-2014", why: "When it resolved — needed to calculate duration and determine outcome" },
        { label: "Severity", value: "Mild", why: "3-point scale (Mild/Moderate/Severe) — distinct from 'serious', which has specific regulatory criteria" },
        { label: "Serious?", value: "No", why: "An SAE must meet criteria: death, hospitalization, disability, etc. — a mild headache doesn't qualify" },
        { label: "Relationship to Study Drug", value: "Possibly", why: "Investigator's causality assessment — from 'Not Related' to 'Definitely Related'" },
        { label: "Action Taken with Study Drug", value: "Dose Not Changed", why: "Did the AE cause a dose change? This links safety to exposure" },
        { label: "Outcome", value: "Recovered/Resolved", why: "Final status — FDA needs to know if it's ongoing at study end" },
      ],
    },

    domainQuiz: {
      question: "A headache that started during study treatment — which SDTM domain should this go to?",
      options: [
        { domain: "AE", label: "AE — Adverse Events", correct: true, explanation: "Correct! An adverse event is any untoward medical occurrence during study participation. This headache started after treatment began, making it a treatment-emergent AE." },
        { domain: "MH", label: "MH — Medical History", correct: false, explanation: "MH captures conditions that existed before the study. This headache started during treatment, not before." },
        { domain: "CE", label: "CE — Clinical Events", correct: false, explanation: "CE is used in specific therapeutic areas (like oncology) for predefined events. Standard AE collection goes to the AE domain." },
        { domain: "HO", label: "HO — Healthcare Encounters", correct: false, explanation: "HO tracks hospitalizations and ER visits. This mild headache didn't require medical attention." },
      ],
    },

    mapping: {
      description:
        "Each CRF field transforms into one or more SDTM variables. Some variables are derived by the programmer — they don't appear on the CRF at all.",
      rows: [
        { source: "Derived", crfField: "—", sdtmVar: "STUDYID", value: "CDISCPILOT01", transform: "Constant", explanation: "Every SDTM row must identify the study. This is a constant for all records." },
        { source: "Derived", crfField: "—", sdtmVar: "DOMAIN", value: "AE", transform: "Constant", explanation: "Two-letter domain code. Tells the FDA which table this row belongs to." },
        { source: "Derived", crfField: "—", sdtmVar: "USUBJID", value: "01-701-1015", transform: "Concatenated", explanation: "Unique Subject ID = Study + Site + Subject. Must be unique across the ENTIRE study." },
        { source: "Derived", crfField: "—", sdtmVar: "AESEQ", value: "1", transform: "Sequence counter", explanation: "1st AE record for this subject. A second AE would be AESEQ=2." },
        { source: "CRF", crfField: "Adverse Event Term", sdtmVar: "AETERM", value: "HEADACHE", transform: "Upper case", explanation: "Verbatim term from the CRF, uppercased per SDTM convention." },
        { source: "Coded", crfField: "Adverse Event Term", sdtmVar: "AEDECOD", value: "Headache", transform: "MedDRA coding", explanation: "MedDRA Preferred Term. Medical coders map the verbatim term to a standardized dictionary." },
        { source: "Coded", crfField: "Adverse Event Term", sdtmVar: "AEBODSYS", value: "Nervous system disorders", transform: "MedDRA coding", explanation: "MedDRA System Organ Class — groups the AE into a body system for aggregate analysis." },
        { source: "CRF", crfField: "Severity", sdtmVar: "AESEV", value: "MILD", transform: "Controlled terminology", explanation: "Must use SDTM controlled terms: MILD, MODERATE, or SEVERE." },
        { source: "CRF", crfField: "Serious?", sdtmVar: "AESER", value: "N", transform: "Y/N coding", explanation: "Yes/No coded. 'Serious' has a specific regulatory definition — different from 'severe'." },
        { source: "CRF", crfField: "Relationship to Study Drug", sdtmVar: "AEREL", value: "POSSIBLE", transform: "Controlled terminology", explanation: "Causality assessment. Sponsors define the allowed values." },
        { source: "CRF", crfField: "Action Taken", sdtmVar: "AEACN", value: "DOSE NOT CHANGED", transform: "Controlled terminology", explanation: "ACN codelist. Links the safety event to the drug exposure — crucial for benefit-risk assessment." },
        { source: "CRF", crfField: "Outcome", sdtmVar: "AEOUT", value: "RECOVERED/RESOLVED", transform: "Controlled terminology", explanation: "OUT codelist. FDA reviewers check this to see if AEs resolved." },
        { source: "CRF", crfField: "Start Date", sdtmVar: "AESTDTC", value: "2014-01-06", transform: "ISO 8601", explanation: "Dates MUST be in ISO 8601 (YYYY-MM-DD). The CRF said '06-JAN-2014' — the programmer converts it." },
        { source: "CRF", crfField: "End Date", sdtmVar: "AEENDTC", value: "2014-01-09", transform: "ISO 8601", explanation: "Same conversion. Partial dates are allowed: '2014-01' if only month is known." },
        { source: "Derived", crfField: "—", sdtmVar: "AESTDY", value: "3", transform: "Calculated", explanation: "Study Day = (AE start date) − (reference start date) + 1. Day 1 = first dose." },
        { source: "Derived", crfField: "—", sdtmVar: "AEENDY", value: "6", transform: "Calculated", explanation: "Study Day of AE end. Places the event on the treatment timeline." },
      ],
    },

    finalRow: {
      description: "This is the actual SDTM row that gets packaged in the electronic submission to the FDA. One row = one adverse event.",
      columns: ["STUDYID", "DOMAIN", "USUBJID", "AESEQ", "AETERM", "AEDECOD", "AEBODSYS", "AESEV", "AESER", "AEREL", "AEACN", "AEOUT", "AESTDTC", "AEENDTC", "AESTDY", "AEENDY"],
      values: ["CDISCPILOT01", "AE", "01-701-1015", "1", "HEADACHE", "Headache", "Nervous system disorders", "MILD", "N", "POSSIBLE", "DOSE NOT CHANGED", "RECOVERED/RESOLVED", "2014-01-06", "2014-01-09", "3", "6"],
      highlights: {
        AETERM: "Verbatim term — exactly what the CRF said",
        AEDECOD: "Standardized by MedDRA — enables cross-study comparison",
        AESTDY: "Study Day 3 — derived, not collected",
        AEACN: "Links safety to exposure — dose was not changed",
      },
    },

    reviewQuiz: [
      {
        question: "Why was '06-JAN-2014' converted to '2014-01-06'?",
        options: [
          { text: "To save storage space", correct: false },
          { text: "ISO 8601 is the required date format in SDTM", correct: true },
          { text: "The FDA only accepts numeric dates", correct: false },
          { text: "To make it sort alphabetically", correct: false },
        ],
        explanation: "SDTM requires all dates in ISO 8601 format (YYYY-MM-DD). This is an international standard that's unambiguous across regions.",
      },
      {
        question: "What does AESTDY = 3 mean?",
        options: [
          { text: "The AE lasted 3 days", correct: false },
          { text: "The AE started on Study Day 3 (3 days after first dose)", correct: true },
          { text: "This is the 3rd AE for this patient", correct: false },
          { text: "Severity level 3", correct: false },
        ],
        explanation: "Study Day is calculated as: (event date − reference start date) + 1. It places the event on the treatment timeline.",
      },
      {
        question: "AETERM = 'HEADACHE' and AEDECOD = 'Headache'. Why two variables?",
        options: [
          { text: "It's a duplicate — they should be merged", correct: false },
          { text: "AETERM is the verbatim text; AEDECOD is the standardized MedDRA coded term", correct: true },
          { text: "One is for display, one is for the database", correct: false },
          { text: "Different agencies need different formats", correct: false },
        ],
        explanation: "AETERM preserves exactly what was reported. AEDECOD is the MedDRA Preferred Term assigned by medical coders, enabling consistent analysis across studies.",
      },
    ],
  },

  // ────────────────── DM ──────────────────
  {
    id: "dm-enrollment",
    title: "Demographics: Patient Enrollment",
    subtitle: "Map enrollment data to the DM domain — one record per subject",
    domain: "DM",
    domainName: "Demographics",
    difficulty: "Beginner",
    icon: "👤",

    story: {
      title: "The Patient Event",
      patient: { id: "01-701-1015", age: 63, sex: "Female", arm: "Placebo" },
      narrative:
        "Subject 1015, a 63-year-old White female, arrives at Study Site 701 for her enrollment visit in the Xanomeline Alzheimer's study (CDISCPILOT01). She meets all eligibility criteria and is randomized to the Placebo arm. The study coordinator records her demographic information and assigns her subject number. Her first dose date is January 4, 2014.",
      keyFacts: [
        { label: "Subject", value: "1015 at Site 701" },
        { label: "Age", value: "63 years" },
        { label: "Sex", value: "Female" },
        { label: "Race", value: "White" },
        { label: "Ethnicity", value: "Not Hispanic or Latino" },
        { label: "Treatment arm", value: "Placebo" },
      ],
    },

    crf: {
      title: "Demographics Case Report Form",
      description: "Collected once per subject at enrollment. FDA requires demographic data for every clinical trial to analyze safety and efficacy across subgroups.",
      fields: [
        { label: "Subject Number", value: "1015", why: "The site's unique identifier for this patient" },
        { label: "Site Number", value: "701", why: "Identifies which clinic/hospital — important for multi-site analyses" },
        { label: "Age", value: "63", why: "Age at enrollment — FDA analyzes results by age group" },
        { label: "Sex", value: "Female", why: "Biological sex — required for subgroup analysis by regulation" },
        { label: "Race", value: "White", why: "FDA requires race data to assess representation in clinical trials" },
        { label: "Ethnicity", value: "Not Hispanic or Latino", why: "Collected separately from race per FDA guidance" },
        { label: "Date of First Dose", value: "04-JAN-2014", why: "Reference start date — all Study Day calculations start from here" },
        { label: "Randomized Treatment", value: "Placebo", why: "Which arm the patient is assigned to — defines the analysis population" },
      ],
    },

    domainQuiz: {
      question: "A patient's age, sex, race, and treatment arm at enrollment — which domain?",
      options: [
        { domain: "DM", label: "DM — Demographics", correct: true, explanation: "Correct! DM captures one record per subject with core demographic and trial information. It's the most fundamental domain — every study has DM." },
        { domain: "SC", label: "SC — Subject Characteristics", correct: false, explanation: "SC captures additional characteristics not in DM (like disease-specific traits). Standard demographics go to DM." },
        { domain: "DS", label: "DS — Disposition", correct: false, explanation: "DS tracks study milestones (informed consent, randomization, completion/withdrawal). Demographics go to DM." },
        { domain: "SV", label: "SV — Subject Visits", correct: false, explanation: "SV records when visits occurred. Enrollment demographics go to DM, not SV." },
      ],
    },

    mapping: {
      description: "DM is unique — it has exactly ONE row per subject. It's the anchor that connects all other domain data for this patient via USUBJID.",
      rows: [
        { source: "Derived", crfField: "—", sdtmVar: "STUDYID", value: "CDISCPILOT01", transform: "Constant", explanation: "Every row identifies the study." },
        { source: "Derived", crfField: "—", sdtmVar: "DOMAIN", value: "DM", transform: "Constant", explanation: "DM = Demographics." },
        { source: "Derived", crfField: "Site + Subject", sdtmVar: "USUBJID", value: "01-701-1015", transform: "Concatenated", explanation: "Study prefix (01) + Site (701) + Subject (1015). Must be globally unique across all studies from a sponsor." },
        { source: "CRF", crfField: "Subject Number", sdtmVar: "SUBJID", value: "1015", transform: "Direct", explanation: "Subject ID within the site. Combined with SITEID to make USUBJID." },
        { source: "CRF", crfField: "Site Number", sdtmVar: "SITEID", value: "701", transform: "Direct", explanation: "Identifies the investigational site." },
        { source: "CRF", crfField: "Age", sdtmVar: "AGE", value: "63", transform: "Numeric", explanation: "Age at consent. Stored as a number for statistical analysis." },
        { source: "Derived", crfField: "—", sdtmVar: "AGEU", value: "YEARS", transform: "Standard", explanation: "Unit for AGE. Always YEARS in most studies." },
        { source: "CRF", crfField: "Sex", sdtmVar: "SEX", value: "F", transform: "Coded", explanation: "'Female' → 'F'. Uses the SEX codelist (F/M/U/UNDIFFERENTIATED)." },
        { source: "CRF", crfField: "Race", sdtmVar: "RACE", value: "WHITE", transform: "Upper case", explanation: "Uppercased per SDTM convention. Uses RACE codelist." },
        { source: "CRF", crfField: "Ethnicity", sdtmVar: "ETHNIC", value: "NOT HISPANIC OR LATINO", transform: "Upper case", explanation: "Only two values: HISPANIC OR LATINO / NOT HISPANIC OR LATINO." },
        { source: "CRF", crfField: "Randomized Treatment", sdtmVar: "ARM", value: "Placebo", transform: "Direct", explanation: "Full description of the treatment arm." },
        { source: "Derived", crfField: "Randomized Treatment", sdtmVar: "ARMCD", value: "Pbo", transform: "Short code", explanation: "Short code for the arm — used in programming. Max 20 characters." },
        { source: "CRF", crfField: "Date of First Dose", sdtmVar: "RFSTDTC", value: "2014-01-04", transform: "ISO 8601", explanation: "Reference Start Date — the anchor for all Study Day calculations across every domain." },
        { source: "Derived", crfField: "Study completion date", sdtmVar: "RFENDTC", value: "2014-07-02", transform: "ISO 8601", explanation: "Reference End Date — typically date of last dose or study completion." },
      ],
    },

    finalRow: {
      description: "The DM domain has exactly one row per subject. This single row is the foundation that every other domain references via USUBJID.",
      columns: ["STUDYID", "DOMAIN", "USUBJID", "SUBJID", "SITEID", "AGE", "AGEU", "SEX", "RACE", "ETHNIC", "ARM", "ARMCD", "RFSTDTC", "RFENDTC"],
      values: ["CDISCPILOT01", "DM", "01-701-1015", "1015", "701", "63", "YEARS", "F", "WHITE", "NOT HISPANIC OR LATINO", "Placebo", "Pbo", "2014-01-04", "2014-07-02"],
      highlights: {
        USUBJID: "The universal subject key — used to join data across ALL domains",
        RFSTDTC: "Reference start date — Study Day 1 for all calculations",
        SEX: "Coded from 'Female' → 'F' using controlled terminology",
        ARM: "Treatment arm — this subject is on Placebo",
      },
    },

    reviewQuiz: [
      {
        question: "How many rows does the DM domain have per subject?",
        options: [
          { text: "One row per visit", correct: false },
          { text: "Exactly one row per subject", correct: true },
          { text: "One row per demographic variable", correct: false },
          { text: "It depends on the study design", correct: false },
        ],
        explanation: "DM always has exactly one record per subject. It's the only domain with this rule — other domains can have multiple records per subject.",
      },
      {
        question: "What is RFSTDTC used for?",
        options: [
          { text: "The date the patient signed informed consent", correct: false },
          { text: "The reference start date used to calculate Study Day across all domains", correct: true },
          { text: "The date of randomization", correct: false },
          { text: "The date of the first CRF entry", correct: false },
        ],
        explanation: "RFSTDTC (Reference Start Date/Time) is the anchor for all Study Day calculations. Usually the date of first dose. Study Day 1 = RFSTDTC.",
      },
      {
        question: "Why is USUBJID = '01-701-1015' instead of just '1015'?",
        options: [
          { text: "To make it look more official", correct: false },
          { text: "Subject 1015 might exist at multiple sites — USUBJID must be unique across the entire study", correct: true },
          { text: "The FDA requires at least 3 parts in the ID", correct: false },
          { text: "It's a historical convention with no practical purpose", correct: false },
        ],
        explanation: "SUBJID (1015) is only unique within a site. Two sites could both have a Subject 1015. USUBJID includes Study + Site + Subject to guarantee global uniqueness.",
      },
    ],
  },

  // ────────────────── CM ──────────────────
  {
    id: "cm-ibuprofen",
    title: "Concomitant Medication: Ibuprofen",
    subtitle: "Map a non-study medication to the CM domain",
    domain: "CM",
    domainName: "Concomitant Medications",
    difficulty: "Intermediate",
    icon: "💊",

    story: {
      title: "The Patient Event",
      patient: { id: "01-701-1015", age: 63, sex: "Female", arm: "Placebo" },
      narrative:
        "After developing a headache on Study Day 3, Subject 1015's physician recommends she take ibuprofen. She takes 200 mg by mouth twice daily for 3 days (January 6–8, 2014). The study coordinator records this as a concomitant medication because it's not the study drug — it's something the patient took alongside the study treatment.",
      keyFacts: [
        { label: "Medication", value: "Ibuprofen" },
        { label: "Dose", value: "200 mg, oral, twice daily" },
        { label: "Duration", value: "Jan 6–8, 2014 (3 days)" },
        { label: "Indication", value: "Headache" },
        { label: "Still taking?", value: "No — stopped after headache resolved" },
      ],
    },

    crf: {
      title: "Concomitant Medication CRF",
      description: "Non-study medications are tracked because they can affect safety analysis (drug interactions) and efficacy (confounding treatments).",
      fields: [
        { label: "Medication Name", value: "Ibuprofen", why: "Verbatim name as reported — may be brand or generic" },
        { label: "Indication", value: "Headache", why: "Why the patient took it — links medications to adverse events" },
        { label: "Dose", value: "200", why: "Amount per administration" },
        { label: "Dose Unit", value: "mg", why: "Unit of measurement for the dose" },
        { label: "Route", value: "Oral", why: "How it was taken — affects bioavailability and interactions" },
        { label: "Frequency", value: "BID (twice daily)", why: "How often — needed to calculate total daily dose" },
        { label: "Start Date", value: "06-JAN-2014", why: "When the patient started taking this medication" },
        { label: "End Date", value: "08-JAN-2014", why: "When stopped — 'Ongoing' if still taking at study end" },
      ],
    },

    domainQuiz: {
      question: "A patient takes ibuprofen for a headache during the study — which domain?",
      options: [
        { domain: "CM", label: "CM — Concomitant Medications", correct: true, explanation: "Correct! CM captures any medication taken that is NOT the study drug. Ibuprofen is a concomitant (alongside) medication." },
        { domain: "EX", label: "EX — Exposure", correct: false, explanation: "EX is specifically for the study drug (Xanomeline). Non-study medications go to CM." },
        { domain: "SU", label: "SU — Substance Use", correct: false, explanation: "SU captures tobacco, alcohol, caffeine, and recreational drugs — not prescribed/OTC medications." },
        { domain: "PR", label: "PR — Procedures", correct: false, explanation: "PR captures non-drug interventions (surgeries, therapies). Medications go to CM." },
      ],
    },

    mapping: {
      description: "CM maps each medication record. If a patient takes 5 medications, they get 5 CM rows. Note how the medication name gets coded using the WHO Drug dictionary.",
      rows: [
        { source: "Derived", crfField: "—", sdtmVar: "STUDYID", value: "CDISCPILOT01", transform: "Constant", explanation: "Study identifier." },
        { source: "Derived", crfField: "—", sdtmVar: "DOMAIN", value: "CM", transform: "Constant", explanation: "CM = Concomitant/Prior Medications." },
        { source: "Derived", crfField: "—", sdtmVar: "USUBJID", value: "01-701-1015", transform: "Concatenated", explanation: "Unique subject identifier." },
        { source: "Derived", crfField: "—", sdtmVar: "CMSEQ", value: "1", transform: "Sequence counter", explanation: "First medication record for this subject." },
        { source: "CRF", crfField: "Medication Name", sdtmVar: "CMTRT", value: "IBUPROFEN", transform: "Upper case", explanation: "Verbatim medication name from the CRF, uppercased." },
        { source: "Coded", crfField: "Medication Name", sdtmVar: "CMDECOD", value: "IBUPROFEN", transform: "WHO Drug coding", explanation: "Drug name coded using WHO Drug dictionary. Brand names would map to the generic here." },
        { source: "Derived", crfField: "—", sdtmVar: "CMCAT", value: "GENERAL CONMED", transform: "Sponsor-defined", explanation: "Category for grouping medications. Sponsor defines the allowed values." },
        { source: "CRF", crfField: "Dose", sdtmVar: "CMDOSE", value: "200", transform: "Numeric", explanation: "Numeric dose per administration." },
        { source: "CRF", crfField: "Dose Unit", sdtmVar: "CMDOSU", value: "mg", transform: "Controlled terminology", explanation: "UNIT codelist. Must use standard abbreviations." },
        { source: "CRF", crfField: "Route", sdtmVar: "CMROUTE", value: "ORAL", transform: "Controlled terminology", explanation: "ROUTE codelist: ORAL, INTRAVENOUS, TOPICAL, etc." },
        { source: "CRF", crfField: "Frequency", sdtmVar: "CMDOSFRQ", value: "BID", transform: "Controlled terminology", explanation: "FREQ codelist: QD (daily), BID (twice), TID (thrice), etc." },
        { source: "CRF", crfField: "Indication", sdtmVar: "CMINDC", value: "HEADACHE", transform: "Upper case", explanation: "Why the medication was taken. Links CM to AE data." },
        { source: "CRF", crfField: "Start Date", sdtmVar: "CMSTDTC", value: "2014-01-06", transform: "ISO 8601", explanation: "When the patient started the medication." },
        { source: "CRF", crfField: "End Date", sdtmVar: "CMENDTC", value: "2014-01-08", transform: "ISO 8601", explanation: "When the patient stopped. Blank if ongoing." },
      ],
    },

    finalRow: {
      description: "One row per medication-period. If the patient restarted ibuprofen later, that would be a separate CM row with a new CMSEQ.",
      columns: ["STUDYID", "DOMAIN", "USUBJID", "CMSEQ", "CMTRT", "CMDECOD", "CMCAT", "CMDOSE", "CMDOSU", "CMROUTE", "CMDOSFRQ", "CMINDC", "CMSTDTC", "CMENDTC"],
      values: ["CDISCPILOT01", "CM", "01-701-1015", "1", "IBUPROFEN", "IBUPROFEN", "GENERAL CONMED", "200", "mg", "ORAL", "BID", "HEADACHE", "2014-01-06", "2014-01-08"],
      highlights: {
        CMTRT: "Verbatim med name — exactly what was on the CRF (uppercased)",
        CMDECOD: "WHO Drug coded term — brand names get mapped to generic here",
        CMINDC: "Links to AE — ibuprofen was taken for the headache",
        CMDOSFRQ: "BID = twice daily — controlled terminology, not free text",
      },
    },

    reviewQuiz: [
      {
        question: "What's the difference between CM and EX?",
        options: [
          { text: "CM is for pills, EX is for injections", correct: false },
          { text: "CM is for non-study drugs, EX is for the study drug", correct: true },
          { text: "They're interchangeable", correct: false },
          { text: "CM is collected, EX is derived", correct: false },
        ],
        explanation: "CM tracks all medications that are NOT the investigational product. EX tracks administration of the study drug.",
      },
      {
        question: "Why does CM capture CMINDC (indication)?",
        options: [
          { text: "Just for administrative completeness", correct: false },
          { text: "To link medications to adverse events and analyze treatment patterns", correct: true },
          { text: "The FDA requires it for drug pricing", correct: false },
          { text: "To check if the pharmacy filled the right prescription", correct: false },
        ],
        explanation: "CMINDC links CM and AE data. If 10 subjects took ibuprofen for headache, and all are in the active arm, that's a safety signal worth investigating.",
      },
      {
        question: "If the CRF says 'Advil', what happens in CMTRT vs CMDECOD?",
        options: [
          { text: "Both would say 'Advil'", correct: false },
          { text: "CMTRT = 'ADVIL' (verbatim), CMDECOD = 'IBUPROFEN' (coded generic)", correct: true },
          { text: "Both would say 'Ibuprofen'", correct: false },
          { text: "CMTRT = 'Ibuprofen', CMDECOD = 'Advil'", correct: false },
        ],
        explanation: "CMTRT preserves the verbatim reported name (uppercased). CMDECOD maps it to the standardized WHO Drug term (generic name) so all ibuprofen use can be analyzed together.",
      },
    ],
  },

  // ────────────────── VS ──────────────────
  {
    id: "vs-bloodpressure",
    title: "Vital Signs: Blood Pressure",
    subtitle: "Map a blood pressure reading to the VS domain",
    domain: "VS",
    domainName: "Vital Signs",
    difficulty: "Intermediate",
    icon: "❤️",

    story: {
      title: "The Patient Event",
      patient: { id: "01-701-1015", age: 63, sex: "Female", arm: "Placebo" },
      narrative:
        "At her screening visit on January 2, 2014, the study nurse takes Subject 1015's vital signs. With the patient seated and cuff on her arm, the nurse measures blood pressure: 132/78 mmHg. Since this is before treatment starts, it becomes the baseline measurement against which all future readings will be compared.",
      keyFacts: [
        { label: "Test", value: "Blood Pressure (systolic)" },
        { label: "Result", value: "132 mmHg" },
        { label: "Position", value: "Sitting" },
        { label: "Location", value: "Arm" },
        { label: "Visit", value: "Screening" },
        { label: "Baseline?", value: "Yes — pre-treatment reference" },
      ],
    },

    crf: {
      title: "Vital Signs CRF",
      description: "Vital signs are measured at every visit. They're a key safety measure — abnormal values can signal drug toxicity.",
      fields: [
        { label: "Test Name", value: "Systolic Blood Pressure", why: "Which measurement — systolic and diastolic are recorded as separate rows in SDTM" },
        { label: "Result", value: "132", why: "The numeric measurement value" },
        { label: "Unit", value: "mmHg", why: "Millimeters of mercury — the standard BP unit" },
        { label: "Position", value: "Sitting", why: "Blood pressure varies by position — must be standardized across visits" },
        { label: "Location", value: "Arm", why: "Where the cuff was placed" },
        { label: "Visit", value: "Screening 1", why: "Which clinical visit — ties to the visit schedule" },
        { label: "Date/Time", value: "02-JAN-2014", why: "When the measurement was taken" },
      ],
    },

    domainQuiz: {
      question: "A nurse measures a patient's blood pressure at a clinic visit — which domain?",
      options: [
        { domain: "VS", label: "VS — Vital Signs", correct: true, explanation: "Correct! Vital signs (BP, heart rate, temperature, respiratory rate, weight, height) go to VS. These are routine physical measurements taken at study visits." },
        { domain: "LB", label: "LB — Laboratory Tests", correct: false, explanation: "LB is for tests on body specimens (blood draws, urine). Blood pressure is measured on the patient directly, not in a lab." },
        { domain: "PE", label: "PE — Physical Examination", correct: false, explanation: "PE captures narrative findings from a physical exam. Vital signs have their own domain because they produce specific numeric values." },
        { domain: "FA", label: "FA — Findings About", correct: false, explanation: "FA is a supplemental domain for additional findings about events or interventions. Standard vital signs go to VS." },
      ],
    },

    mapping: {
      description: "VS is a Findings-class domain — one row per test per visit per subject. Blood pressure creates TWO rows: one for systolic, one for diastolic. Here we focus on the systolic row.",
      rows: [
        { source: "Derived", crfField: "—", sdtmVar: "STUDYID", value: "CDISCPILOT01", transform: "Constant", explanation: "Study identifier." },
        { source: "Derived", crfField: "—", sdtmVar: "DOMAIN", value: "VS", transform: "Constant", explanation: "VS = Vital Signs." },
        { source: "Derived", crfField: "—", sdtmVar: "USUBJID", value: "01-701-1015", transform: "Concatenated", explanation: "Unique subject identifier." },
        { source: "Derived", crfField: "—", sdtmVar: "VSSEQ", value: "1", transform: "Sequence counter", explanation: "Sequence number within this subject's VS records." },
        { source: "Coded", crfField: "Test Name", sdtmVar: "VSTESTCD", value: "SYSBP", transform: "Short code", explanation: "Standardized test code. SYSBP = Systolic Blood Pressure. Max 8 characters." },
        { source: "CRF", crfField: "Test Name", sdtmVar: "VSTEST", value: "Systolic Blood Pressure", transform: "Full name", explanation: "Decoded test name. Paired with VSTESTCD." },
        { source: "CRF", crfField: "Result", sdtmVar: "VSORRES", value: "132", transform: "Character", explanation: "Original Result — stored as character because some results can be text like '>200'." },
        { source: "CRF", crfField: "Unit", sdtmVar: "VSORRESU", value: "mmHg", transform: "Direct", explanation: "Original Result Unit — the unit as collected." },
        { source: "Derived", crfField: "Result", sdtmVar: "VSSTRESN", value: "132", transform: "Numeric", explanation: "Standardized numeric result. Would convert if units differed across sites." },
        { source: "Derived", crfField: "Result", sdtmVar: "VSSTRESC", value: "132", transform: "Character", explanation: "Standardized result as character — character version of VSSTRESN." },
        { source: "Derived", crfField: "Unit", sdtmVar: "VSSTRESU", value: "mmHg", transform: "Standard", explanation: "Standard unit. If a site used kPa, it would be converted to mmHg here." },
        { source: "CRF", crfField: "Position", sdtmVar: "VSPOS", value: "SITTING", transform: "Controlled terminology", explanation: "POSITION codelist: SITTING, STANDING, SUPINE." },
        { source: "CRF", crfField: "Location", sdtmVar: "VSLOC", value: "ARM", transform: "Controlled terminology", explanation: "LOC codelist — where measurement was taken." },
        { source: "Derived", crfField: "—", sdtmVar: "VSBLFL", value: "Y", transform: "Flag", explanation: "Baseline Flag = 'Y'. Last non-missing result before treatment. Only one record per test gets this." },
        { source: "CRF", crfField: "Visit", sdtmVar: "VISITNUM", value: "1", transform: "Numeric", explanation: "Visit sequence number for sorting." },
        { source: "CRF", crfField: "Visit", sdtmVar: "VISIT", value: "SCREENING 1", transform: "Text", explanation: "Visit name from the protocol." },
        { source: "CRF", crfField: "Date/Time", sdtmVar: "VSDTC", value: "2014-01-02", transform: "ISO 8601", explanation: "Date/Time of the measurement." },
      ],
    },

    finalRow: {
      description: "One row per test per timepoint. The diastolic reading (78 mmHg) would be a SECOND row with VSTESTCD='DIABP'. Blood pressure always creates two SDTM rows.",
      columns: ["STUDYID", "DOMAIN", "USUBJID", "VSSEQ", "VSTESTCD", "VSTEST", "VSORRES", "VSORRESU", "VSSTRESN", "VSSTRESU", "VSPOS", "VSLOC", "VSBLFL", "VISITNUM", "VISIT", "VSDTC"],
      values: ["CDISCPILOT01", "VS", "01-701-1015", "1", "SYSBP", "Systolic Blood Pressure", "132", "mmHg", "132", "mmHg", "SITTING", "ARM", "Y", "1", "SCREENING 1", "2014-01-02"],
      highlights: {
        VSTESTCD: "Short code — BP = 2 rows (SYSBP + DIABP)",
        VSORRES: "Character field — even numeric results stored as text",
        VSBLFL: "Baseline flag — reference for change-from-baseline analysis",
        VSSTRESU: "Standard unit — ensures all sites report in the same unit",
      },
    },

    reviewQuiz: [
      {
        question: "Blood pressure is 132/78 mmHg. How many VS rows does this create?",
        options: [
          { text: "One row with both values", correct: false },
          { text: "Two rows — one for systolic (132), one for diastolic (78)", correct: true },
          { text: "Three rows — systolic, diastolic, and combined", correct: false },
          { text: "It depends on the study protocol", correct: false },
        ],
        explanation: "SDTM Findings domains store one result per row. Systolic and diastolic are different tests (SYSBP, DIABP), so they get separate rows.",
      },
      {
        question: "Why does VSORRES store '132' as character instead of a number?",
        options: [
          { text: "A programming error", correct: false },
          { text: "Some original results are text ('>200', 'BLQ', 'TRACE') that can't be numeric", correct: true },
          { text: "To save storage space", correct: false },
          { text: "Numbers aren't allowed in SDTM", correct: false },
        ],
        explanation: "The 'original result' variables (*ORRES) are character because not all results are numeric. Values like '>500' or 'TRACE' can't be stored as numbers. The numeric version goes in *STRESN.",
      },
      {
        question: "What does VSBLFL = 'Y' mean?",
        options: [
          { text: "The blood pressure is below the lower limit", correct: false },
          { text: "This is the baseline (pre-treatment reference) measurement", correct: true },
          { text: "This is an abnormal value", correct: false },
          { text: "The value was verified by a second nurse", correct: false },
        ],
        explanation: "Baseline Flag marks the pre-treatment reference measurement. FDA reviewers use it to calculate 'change from baseline' — the primary way to assess drug effects.",
      },
    ],
  },

  // ────────────────── LB ──────────────────
  {
    id: "lb-alt",
    title: "Lab Test: Liver Enzyme (ALT)",
    subtitle: "Map a laboratory result to the LB domain",
    domain: "LB",
    domainName: "Laboratory Tests",
    difficulty: "Intermediate",
    icon: "🔬",

    story: {
      title: "The Patient Event",
      patient: { id: "01-701-1015", age: 63, sex: "Female", arm: "Placebo" },
      narrative:
        "At screening, a blood sample is drawn from Subject 1015 and sent to the central lab. The chemistry panel results come back: her ALT (alanine aminotransferase, a liver enzyme) is 23 U/L. The lab's normal range for ALT is 7–56 U/L, so this result is normal. This matters because the study drug must be metabolized by the liver — abnormal liver function at baseline could be a safety concern.",
      keyFacts: [
        { label: "Lab test", value: "ALT (Alanine Aminotransferase)" },
        { label: "Panel", value: "Chemistry" },
        { label: "Result", value: "23 U/L" },
        { label: "Normal range", value: "7–56 U/L" },
        { label: "Interpretation", value: "Normal" },
        { label: "Fasting?", value: "No" },
      ],
    },

    crf: {
      title: "Laboratory Test CRF",
      description: "Lab results often come electronically from a central lab. The CRF may be auto-populated. Each analyte becomes one row in the dataset.",
      fields: [
        { label: "Lab Test Name", value: "Alanine Aminotransferase", why: "Which analyte was measured from the sample" },
        { label: "Lab Category", value: "Chemistry", why: "Panel grouping: Chemistry, Hematology, Urinalysis, etc." },
        { label: "Result", value: "23", why: "The measured value" },
        { label: "Unit", value: "U/L", why: "Units per liter — the measurement unit" },
        { label: "Reference Range Low", value: "7", why: "Lab-specific normal range — varies by lab and method" },
        { label: "Reference Range High", value: "56", why: "Values outside this range are flagged" },
        { label: "Fasting Status", value: "No", why: "Some tests (glucose, lipids) require fasting for valid results" },
        { label: "Collection Date", value: "02-JAN-2014", why: "When the blood was drawn" },
      ],
    },

    domainQuiz: {
      question: "A blood draw result (liver enzyme level) from a central lab — which domain?",
      options: [
        { domain: "LB", label: "LB — Laboratory Test Results", correct: true, explanation: "Correct! LB captures quantitative and qualitative results from tests on body specimens (blood, urine, CSF, etc.)." },
        { domain: "VS", label: "VS — Vital Signs", correct: false, explanation: "VS is for direct physical measurements (BP, temperature). Lab tests analyze body specimens, not the patient directly." },
        { domain: "MB", label: "MB — Microbiology Specimen", correct: false, explanation: "MB is specifically for microbiology (cultures, sensitivities). Chemistry results go to LB." },
        { domain: "EG", label: "EG — ECG Test Results", correct: false, explanation: "EG is exclusively for electrocardiogram results. Blood chemistry goes to LB." },
      ],
    },

    mapping: {
      description: "LB is often the largest domain — dozens of tests per visit × many visits = thousands of rows per subject. Note how original and standard results are kept separately.",
      rows: [
        { source: "Derived", crfField: "—", sdtmVar: "STUDYID", value: "CDISCPILOT01", transform: "Constant", explanation: "Study identifier." },
        { source: "Derived", crfField: "—", sdtmVar: "DOMAIN", value: "LB", transform: "Constant", explanation: "LB = Laboratory Test Results." },
        { source: "Derived", crfField: "—", sdtmVar: "USUBJID", value: "01-701-1015", transform: "Concatenated", explanation: "Unique subject identifier." },
        { source: "Derived", crfField: "—", sdtmVar: "LBSEQ", value: "1", transform: "Sequence counter", explanation: "Sequence number within this subject's lab records." },
        { source: "Coded", crfField: "Lab Test Name", sdtmVar: "LBTESTCD", value: "ALT", transform: "Short code", explanation: "Standardized 3-character test code. Max allowed is 8." },
        { source: "CRF", crfField: "Lab Test Name", sdtmVar: "LBTEST", value: "Alanine Aminotransferase", transform: "Full name", explanation: "Full decoded test name. Paired with LBTESTCD." },
        { source: "CRF", crfField: "Lab Category", sdtmVar: "LBCAT", value: "CHEMISTRY", transform: "Upper case", explanation: "Grouping category: CHEMISTRY, HEMATOLOGY, URINALYSIS, etc." },
        { source: "CRF", crfField: "Result", sdtmVar: "LBORRES", value: "23", transform: "Character", explanation: "Original Result — character, because some results are '<5' or 'NEGATIVE'." },
        { source: "CRF", crfField: "Unit", sdtmVar: "LBORRESU", value: "U/L", transform: "Direct", explanation: "Original unit as reported by the lab." },
        { source: "Derived", crfField: "Result", sdtmVar: "LBSTRESN", value: "23", transform: "Numeric", explanation: "Standardized numeric result. Would convert if labs used different units." },
        { source: "Derived", crfField: "Result", sdtmVar: "LBSTRESC", value: "23", transform: "Character", explanation: "Standardized result as character — includes non-numeric results." },
        { source: "Derived", crfField: "Unit", sdtmVar: "LBSTRESU", value: "U/L", transform: "Standard", explanation: "Standard unit. All sites report in the same unit." },
        { source: "Derived", crfField: "Result vs Range", sdtmVar: "LBNRIND", value: "NORMAL", transform: "Calculated", explanation: "Normal Range Indicator: NORMAL, LOW, or HIGH. Derived by comparing result to reference range." },
        { source: "CRF", crfField: "Ref Range Low", sdtmVar: "LBSTNRLO", value: "7", transform: "Numeric", explanation: "Lower bound of normal range from the lab." },
        { source: "CRF", crfField: "Ref Range High", sdtmVar: "LBSTNRHI", value: "56", transform: "Numeric", explanation: "Upper bound. Different labs may have different ranges." },
        { source: "CRF", crfField: "Fasting Status", sdtmVar: "LBFAST", value: "N", transform: "Y/N", explanation: "Whether specimen was collected fasting. Important for glucose, lipids." },
        { source: "Derived", crfField: "—", sdtmVar: "LBBLFL", value: "Y", transform: "Flag", explanation: "Baseline Flag — last non-missing result before treatment." },
        { source: "CRF", crfField: "Collection Date", sdtmVar: "LBDTC", value: "2014-01-02", transform: "ISO 8601", explanation: "Specimen collection date/time." },
      ],
    },

    finalRow: {
      description: "In a real study, a single chemistry panel might produce 20+ LB rows (one per analyte). A full study with monthly labs could have thousands of LB rows per subject.",
      columns: ["STUDYID", "DOMAIN", "USUBJID", "LBSEQ", "LBTESTCD", "LBTEST", "LBCAT", "LBORRES", "LBORRESU", "LBSTRESN", "LBSTRESU", "LBNRIND", "LBSTNRLO", "LBSTNRHI", "LBFAST", "LBBLFL", "LBDTC"],
      values: ["CDISCPILOT01", "LB", "01-701-1015", "1", "ALT", "Alanine Aminotransferase", "CHEMISTRY", "23", "U/L", "23", "U/L", "NORMAL", "7", "56", "N", "Y", "2014-01-02"],
      highlights: {
        LBORRES: "Original result — character field, even for numbers",
        LBSTRESN: "Standardized numeric — unit-converted if needed, ready for statistics",
        LBNRIND: "Derived: NORMAL because 7 ≤ 23 ≤ 56",
        LBBLFL: "Baseline flag — pre-treatment reference for safety monitoring",
      },
    },

    reviewQuiz: [
      {
        question: "A lab result is '<5 U/L'. How is this stored in LBORRES vs LBSTRESN?",
        options: [
          { text: "LBORRES = '<5', LBSTRESN = left blank (can't be a number)", correct: true },
          { text: "LBORRES = '5', LBSTRESN = 5", correct: false },
          { text: "Both store '<5'", correct: false },
          { text: "This isn't a valid lab result", correct: false },
        ],
        explanation: "LBORRES preserves the exact result '<5' as text. LBSTRESN can't store '<' since it's numeric, so it's typically null. Some sponsors set it to half the limit (2.5).",
      },
      {
        question: "Why might LBSTRESU differ from LBORRESU?",
        options: [
          { text: "They should always be the same", correct: false },
          { text: "Different labs report in different units; LBSTRESU is the standardized unit after conversion", correct: true },
          { text: "LBSTRESU is always SI units", correct: false },
          { text: "It's a data entry error when they differ", correct: false },
        ],
        explanation: "A US lab might report glucose in mg/dL while a European lab uses mmol/L. LBSTRESU standardizes to one unit so all results are comparable.",
      },
      {
        question: "Why does LB tend to be the largest SDTM domain?",
        options: [
          { text: "Lab tests are more important than other data", correct: false },
          { text: "One row per test × dozens of tests × many visits = thousands of rows per subject", correct: true },
          { text: "The FDA requires more lab detail", correct: false },
          { text: "Lab data is duplicated for quality control", correct: false },
        ],
        explanation: "A chemistry + hematology panel might measure 30+ analytes. With 10 visits, that's 300+ rows per subject. In a 1000-patient trial, LB could have 300,000+ rows.",
      },
    ],
  },

  // ────────────────── EX ──────────────────
  {
    id: "ex-xanomeline",
    title: "Drug Exposure: Xanomeline Patch",
    subtitle: "Map a study drug administration to the EX domain",
    domain: "EX",
    domainName: "Exposure",
    difficulty: "Beginner",
    icon: "💉",

    story: {
      title: "The Patient Event",
      patient: { id: "01-701-1028", age: 71, sex: "Male", arm: "Xanomeline High Dose" },
      narrative:
        "Subject 1028, a 71-year-old man enrolled in the Xanomeline High Dose arm, receives his first study drug application at the clinic on January 4, 2014 (Study Day 1). A nurse applies an 81 mg Xanomeline transdermal patch to his upper arm. This is the investigational product — the drug being studied for Alzheimer's treatment.",
      keyFacts: [
        { label: "Study drug", value: "Xanomeline" },
        { label: "Dose", value: "81 mg" },
        { label: "Form", value: "Transdermal patch" },
        { label: "Application date", value: "January 4, 2014 (Day 1)" },
        { label: "Treatment arm", value: "Xanomeline High Dose" },
        { label: "Visit", value: "Baseline" },
      ],
    },

    crf: {
      title: "Drug Administration Log",
      description: "Study drug exposure is meticulously tracked. Every dose is recorded to ensure accurate exposure data for safety and efficacy analyses.",
      fields: [
        { label: "Treatment Name", value: "Xanomeline", why: "Name of the investigational product being studied" },
        { label: "Dose", value: "81", why: "Dose per administration — this is the high-dose arm (low dose = 54 mg)" },
        { label: "Dose Unit", value: "mg", why: "Unit of the dose" },
        { label: "Dose Form", value: "Patch", why: "Physical form — affects how it enters the body" },
        { label: "Route", value: "Transdermal", why: "Through the skin — different from oral, IV, etc." },
        { label: "Application Date", value: "04-JAN-2014", why: "When the patch was applied" },
        { label: "Removal Date", value: "04-JAN-2014", why: "When removed (same day for daily change)" },
        { label: "Visit", value: "Baseline", why: "Which study visit" },
      ],
    },

    domainQuiz: {
      question: "A study nurse applies the investigational drug patch — which domain?",
      options: [
        { domain: "EX", label: "EX — Exposure", correct: true, explanation: "Correct! EX records every administration of the study drug. It's the definitive record of what treatment the subject actually received." },
        { domain: "CM", label: "CM — Concomitant Medications", correct: false, explanation: "CM is for non-study drugs. The investigational product goes to EX." },
        { domain: "DA", label: "DA — Drug Accountability", correct: false, explanation: "DA tracks drug inventory (tablets dispensed vs returned). Actual administration goes to EX." },
        { domain: "EC", label: "EC — Exposure as Collected", correct: false, explanation: "EC is an alternative when exposure is collected differently. Most studies use EX." },
      ],
    },

    mapping: {
      description: "EX records each exposure event. For a daily patch, each day could be a separate row. For oral drugs, each dispensing period might be one row.",
      rows: [
        { source: "Derived", crfField: "—", sdtmVar: "STUDYID", value: "CDISCPILOT01", transform: "Constant", explanation: "Study identifier." },
        { source: "Derived", crfField: "—", sdtmVar: "DOMAIN", value: "EX", transform: "Constant", explanation: "EX = Exposure." },
        { source: "Derived", crfField: "—", sdtmVar: "USUBJID", value: "01-701-1028", transform: "Concatenated", explanation: "Unique subject ID for Subject 1028." },
        { source: "Derived", crfField: "—", sdtmVar: "EXSEQ", value: "1", transform: "Sequence counter", explanation: "First exposure record. Each daily patch = new EXSEQ." },
        { source: "CRF", crfField: "Treatment Name", sdtmVar: "EXTRT", value: "XANOMELINE", transform: "Upper case", explanation: "Name of the study treatment. Must match across all subjects in the same arm." },
        { source: "CRF", crfField: "Dose", sdtmVar: "EXDOSE", value: "81", transform: "Numeric", explanation: "The actual dose administered." },
        { source: "CRF", crfField: "Dose Unit", sdtmVar: "EXDOSU", value: "mg", transform: "Controlled terminology", explanation: "UNIT codelist." },
        { source: "CRF", crfField: "Dose Form", sdtmVar: "EXDOSFRM", value: "PATCH", transform: "Controlled terminology", explanation: "FRM codelist: TABLET, CAPSULE, PATCH, INJECTION, etc." },
        { source: "CRF", crfField: "Route", sdtmVar: "EXROUTE", value: "TRANSDERMAL", transform: "Controlled terminology", explanation: "ROUTE codelist: ORAL, INTRAVENOUS, TRANSDERMAL, etc." },
        { source: "CRF", crfField: "Application Date", sdtmVar: "EXSTDTC", value: "2014-01-04", transform: "ISO 8601", explanation: "Start of exposure — when the patch was applied." },
        { source: "CRF", crfField: "Removal Date", sdtmVar: "EXENDTC", value: "2014-01-04", transform: "ISO 8601", explanation: "End of exposure — same day for a single-day application." },
        { source: "Derived", crfField: "—", sdtmVar: "EXSTDY", value: "1", transform: "Calculated", explanation: "Study Day 1 — first day of treatment." },
        { source: "CRF", crfField: "Visit", sdtmVar: "VISITNUM", value: "3", transform: "Numeric", explanation: "Visit 3 = Baseline (after Screening visits 1–2)." },
        { source: "CRF", crfField: "Visit", sdtmVar: "VISIT", value: "BASELINE", transform: "Text", explanation: "Visit name from the protocol schedule." },
      ],
    },

    finalRow: {
      description: "One day's study drug exposure. Over a 6-month study, this subject would have ~180 EX rows — one per daily patch application.",
      columns: ["STUDYID", "DOMAIN", "USUBJID", "EXSEQ", "EXTRT", "EXDOSE", "EXDOSU", "EXDOSFRM", "EXROUTE", "EXSTDTC", "EXENDTC", "EXSTDY", "VISITNUM", "VISIT"],
      values: ["CDISCPILOT01", "EX", "01-701-1028", "1", "XANOMELINE", "81", "mg", "PATCH", "TRANSDERMAL", "2014-01-04", "2014-01-04", "1", "3", "BASELINE"],
      highlights: {
        EXTRT: "Study drug — matches ARM in DM for this subject's treatment group",
        EXDOSE: "81 mg — high-dose arm. Low dose = 54 mg, placebo = 0",
        EXSTDY: "Study Day 1 — the first exposure establishing treatment start",
        EXDOSFRM: "PATCH — the delivery mechanism, important for PK analysis",
      },
    },

    reviewQuiz: [
      {
        question: "A placebo subject receives a patch with 0 mg of active drug. Does this get an EX record?",
        options: [
          { text: "No — there's no drug exposure", correct: false },
          { text: "Yes — EX records study treatment including placebo (EXDOSE=0)", correct: true },
          { text: "Only if the subject knows they're on placebo", correct: false },
          { text: "It goes to CM instead", correct: false },
        ],
        explanation: "Placebo gets EX records with EXDOSE=0. This preserves the blind and documents treatment compliance.",
      },
      {
        question: "What connects EX data to AE data for safety analysis?",
        options: [
          { text: "They share the same domain code", correct: false },
          { text: "USUBJID + dates: temporal relationship between exposure and events", correct: true },
          { text: "There's an EXAEREL variable linking them", correct: false },
          { text: "The CRF links them automatically", correct: false },
        ],
        explanation: "AE and EX are linked through USUBJID (same subject) and timing. If an AE starts 3 days into treatment, the reviewer can see exactly what exposure preceded it.",
      },
      {
        question: "When might EXDOSE differ from the planned protocol dose?",
        options: [
          { text: "Never — the dose is always as planned", correct: false },
          { text: "When a dose is reduced due to an AE, or when a subject misses a dose", correct: true },
          { text: "Only if the pharmacy makes an error", correct: false },
          { text: "EXDOSE always equals the planned dose", correct: false },
        ],
        explanation: "EX records ACTUAL exposure. If a dose is reduced from 81 mg to 54 mg due to side effects, EXDOSE changes. AEACN='DOSE REDUCED' in AE would correspond.",
      },
    ],
  },
];
