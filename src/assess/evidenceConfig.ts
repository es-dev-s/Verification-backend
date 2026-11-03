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
    /**
     * Advanced Diploma only: minimum counted years to open Engineering
     * Associate (Rule 5); below this it is not eligible. Replaces both
     * associateMinYears and notEligibleBelowYears for advanced diplomas.
     */
    advancedDiplomaMinYears: 1,
    /**
     * Advanced Diploma only: duration (years) used when none is found (no
     * assessor entry, no printed years / semesters, no credits), so it opens
     * Engineering Associate (Rule 5) instead of manual review.
     */
    advancedDiplomaDefaultYears: 1,
    /** Below this (any other engineering qualification) → not eligible. */
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
    /** Share of a level's subjects that must carry a year / semester to count at all. */
    minTermCoverage: 0.5,
    /** Fewer rows with term info than this → not counted. */
    minTermRows: 3,
    /**
     * A counted half year (from periods, headings or credits) is rounded up to
     * the next whole year: 2.5 → 3, 3.5 → 4. Applied once to the final count,
     * so Gate 1, the tiles and lateral entry all see the whole number. A
     * duration entered by the assessor is used as typed (not rounded).
     */
    roundHalfUp: true,
    /**
     * Credits → years, used only when the transcript prints no usable years /
     * semesters but does give credits (counted years = total credits ÷ credits
     * per year, rounded to the half year). Precedence: printed years /
     * semesters → credits → stated duration. A counted duration entered by the
     * assessor still wins over all of them.
     */
    credits: {
      /** Credits per full-time year when the credit system is not detected. */
      defaultPerYear: 30,
      /** Per-system credits per year, used when the system is detectable. */
      perYear: {
        /** European Credit Transfer System. */
        ects: 60,
        /** US semester credit hours. */
        usSemester: 30,
        /** Australian credit points. */
        australianCreditPoints: 48,
      },
      /** Countries whose degrees use ECTS (when the transcript does not name the system). */
      ectsCountries: [
        "austria", "belgium", "bulgaria", "croatia", "cyprus", "czech", "denmark", "estonia",
        "finland", "france", "germany", "greece", "hungary", "iceland", "ireland", "italy",
        "latvia", "lithuania", "luxembourg", "malta", "netherlands", "norway", "poland",
        "portugal", "romania", "slovakia", "slovenia", "spain", "sweden", "switzerland",
      ] as string[],
      /**
       * A conversion outside this range (years) is ignored as implausible (e.g. a
       * partial credit total); the stated duration is used instead. The minimum
       * matches gate.notEligibleBelowYears so credits alone never fail a case.
       */
      minYears: 2,
      maxYears: 7,
    },
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
