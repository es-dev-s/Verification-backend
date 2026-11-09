/**
 * Risk scoring governance settings (Step 5 risk).
 *
 * The weights and the risk-band thresholds live here, separate from the
 * component calculations in scoreRisk.ts. Change these values only after
 * governance approval.
 *
 * Overall academic alignment score (0–100):
 *   Overall = wF × Fundamental + wC × Core + wH × Historical
 * When a component has no data (e.g. no past cases for the ANZSCO), it is
 * left out and the remaining weights are re-normalised to sum to 1.
 *
 * Risk category from the overall score:
 *   overall ≥ bands.noRisk → No risk
 *   overall ≥ bands.low    → Low risk
 *   overall ≥ bands.medium → Medium risk
 *   otherwise              → High risk
 */

export type RiskWeights = {
  fundamental: number;
  core: number;
  historical: number;
};

export type RiskBandThresholds = {
  /** Minimum overall % for No risk. */
  noRisk: number;
  /** Minimum overall % for Low risk. */
  low: number;
  /** Minimum overall % for Medium risk (below this is High risk). */
  medium: number;
};

export type RiskScoringConfig = {
  /** Identifier saved with each result so a later change of settings is traceable. */
  version: string;
  /** Approved weights (30 / 50 / 20). */
  weights: RiskWeights;
  /**
   * PENDING CONFIRMATION — reused from the earlier score bands. These are the
   * only band thresholds: the web reads them from each risk result
   * (scoring.bands), never from its own copy.
   */
  bands: RiskBandThresholds;
};

export const RISK_SCORING_CONFIG: RiskScoringConfig = {
  version: "2026-11-03-major-supporting",
  weights: { fundamental: 0.3, core: 0.5, historical: 0.2 },
  bands: { noRisk: 85, low: 75, medium: 50 },
};
