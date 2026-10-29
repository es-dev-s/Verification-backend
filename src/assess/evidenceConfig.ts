/**
 * Qualification evidence defaults (Gate 1, duration counting, engineering decision).
 * These are policy values, kept out of the logic so they can be changed in one
 * place. DEFAULTS NEED CONFIRMATION by the assessment team.
 */
export const evidenceConfig = {
  /**
   * Gate 1 (qualification eligibility, checked before any scoring; see gate1.ts).
   * Minimum counted programme length in years per track.
   */
  gate: {
    professionalMinYears: 4,
    technologistMinYears: 3,
    associateMinYears: 2,
    /** Below this (any engineering qualification) → not eligible. */
    notEligibleBelowYears: 2,
    /**
     * Config hook: 3-year degrees from these programmes / countries / institutions
     * may be recognised at a higher level → manual review instead of the
     * Technologist track. Every field given must match (title is a
     * case-insensitive regular expression; country / institution are
     * case-insensitive substrings). Empty by default.
     */
    recognisedHigherProgrammes: [] as Array<{
      titlePattern?: string;
      country?: string;
      institution?: string;
      note?: string;
    }>,
  },
  duration: {
    /** Counted vs stated duration may differ by this much (years). */
    toleranceYears: 0.5,
    /** Share of a level's subjects that must carry a year / semester to count at all. */
    minTermCoverage: 0.5,
    /** Fewer rows with term info than this → not counted. */
    minTermRows: 3,
  },
  engineering: {
    /** Share of subjects that look like engineering at or above which the evidence is strong. */
    strongShare: 0.4,
    /** Share below which the evidence is weak. */
    weakShare: 0.2,
    /** A clear "no" needs at least this many subjects to judge from. */
    minSubjects: 6,
  },
};

export const ENGINEERING_TECHNOLOGIST_ANZSCO = "233914";
export const MECH_DRAFTSPERSON_ANZSCO_CODE = "312511";

/** Fingerprint for the scoring cache key. */
export function evidenceConfigFingerprint() {
  return evidenceConfig;
}
