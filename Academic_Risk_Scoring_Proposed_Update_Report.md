**PROPOSED ACADEMIC RISK SCORING MODEL**

*Recommended Revision to the Existing Occupation-Matching Assessment Engine*

# 1. Executive Summary

The existing scoring model uses 3 components: Tier-1 Foundation Subjects, Tier-2 Core Subjects, and Historical Precedent.

The proposed revision is to make the assessment substantially more evidence-based by removing Degree Title and Keyword Match from the risk calculation and concentrating the score on three factors: Fundamental Subjects, Core Subjects, and Historical Data. This approach places greater emphasis on actual academic subject coverage and makes the final risk percentage easier to explain and audit.

# 2. Key Proposed Change

The application should not primarily assess academic suitability from the wording of a qualification title or from keyword frequency. Instead, the main assessment should be based on whether the candidate has studied the fundamental and occupation-specific core subjects expected for the occupation, supported by evidence from historical cases.

# 3. Proposed Weightage

| **Component**        | **Weight** | **Purpose**                                                                                                   | **Priority** |
|----------------------|------------|---------------------------------------------------------------------------------------------------------------|--------------|
| Fundamental Subjects | 30%        | Measures foundational academic coverage required for the engineering discipline.                              | High         |
| Core Subjects        | 50%        | Measures occupation-specific academic coverage and provides the strongest evidence of occupational alignment. | Very High    |
| Historical Data      | 20%        | Uses comparable historical assessment outcomes as supporting evidence for the current profile.                | High         |
| **Total**            | **100%**   | **Final weighted assessment.**                                                                                | **—**        |

# 4. Recommended Scoring Logic

The proposed overall academic alignment score should be calculated as:

**Overall Score = (30% × Fundamental Subject Score) + (50% × Core Subject Score) + (20% × Historical Data Score)**

The resulting score should then be translated into the application's risk category according to the approved risk-band thresholds. The exact risk-band thresholds should be treated as a separate governance setting rather than being embedded within the three component calculations.

# 5. Fundamental Subject Assessment

Fundamental Subjects should measure whether the candidate has the academic foundation expected for the relevant engineering discipline. The existing subject methodology can be retained by separating subjects into Major and Supporting groups.

Recommended calculation: 70% Major Fundamental Subjects + 30% Supporting Fundamental Subjects.

Major subjects should represent the essential foundation of the discipline, while Supporting subjects should provide additional evidence without carrying the same influence as defining subjects.

# 6. Core Subject Assessment

Core Subjects should be the most heavily weighted component because they provide the strongest direct evidence of whether the candidate's academic background aligns with the specific occupation.

Recommended calculation: 70% Major Core Subjects + 30% Supporting Core Subjects.

Major Core Subjects should contain the defining subjects that identify the occupation. Missing a defining core subject should therefore have a more visible effect on the final score than missing a supporting or elective-type subject.

# 7. Historical Data Assessment

Historical data should be used as supporting evidence rather than merely counting how many cases exist for an ANZSCO code. The application should consider comparable historical outcomes and present the evidence transparently.

- Total comparable historical cases.

- Number of positive outcomes.

- Number of negative outcomes.

- Positive outcome percentage.

- Negative outcome percentage.

- Where available, similarity between the current academic profile and the historical profiles.

The existing document currently uses a capped case-count approach for Historical Precedent. Under the proposed model, the historical component should preferably communicate outcome quality, not just historical volume.

# 8. Risk Percentage Must Be Explainable

A major requirement of the revised model is that the application should clearly explain why a particular risk percentage has been produced. The user should not see only a final number such as 'Risk: 28%'.

The application should display the underlying component scores and their contribution to the final result.

| **Factor**           | **Example Result** | **Weighted Contribution** | **Reason**                                     |
|----------------------|--------------------|---------------------------|------------------------------------------------|
| Fundamental Subjects | 92%                | 27.6 / 30                 | Strong foundational coverage                   |
| Core Subjects        | 84%                | 42.0 / 50                 | Strong occupation-specific alignment           |
| Historical Data      | 78%                | 15.6 / 20                 | Historical outcomes are predominantly positive |
| **Overall Score**    | **85.2%**          | **85.2 / 100**            | **Strong overall academic alignment**          |

# 9. Recommended Explanation Shown in the Application

The application should generate a short, evidence-based explanation alongside the risk result. For example:

> *Overall Risk: 22% — Low Risk  
>   
> Reason: The candidate demonstrates strong coverage of fundamental and occupation-specific core subjects. Fundamental subject coverage is 92%, while core subject coverage is 84%. Historical comparable cases also show predominantly positive outcomes. The remaining risk is mainly associated with gaps in specific core subjects.*

# 10. Why Degree Title and Keywords Should Be Removed

- Degree titles can vary substantially between institutions and countries even when the underlying academic content is similar.

- Keyword matching can create false confidence when a term appears in a transcript without demonstrating meaningful academic coverage.

- Actual subject coverage provides stronger evidence of what the candidate has studied.

- Removing these two factors reduces the possibility of the score being influenced by wording rather than academic substance.

- The resulting score is easier for assessors, team leaders, and clients to understand and defend.

# 11. Recommended Result Presentation

The result screen should present the overall risk together with a transparent breakdown. A recommended structure is:

- Overall Risk Percentage and Risk Category.

- Fundamental Subject Score and percentage coverage.

- Core Subject Score and percentage coverage.

- Historical Data Score and historical positive/negative outcome statistics.

- Top reasons reducing risk.

- Top reasons increasing risk.

- Specific missing Major Core Subjects, where applicable.

- A concise final explanation showing how the three components produced the final result.

# 12. Governance Considerations

The weightage should remain configurable so that it can be reviewed against future case data. However, any change to the weights should be documented and approved rather than changed dynamically from individual cases.

Historical data should also be periodically reviewed as the case database grows. The system should distinguish between historical case volume and historical outcome performance so that a large number of cases does not automatically imply a low-risk occupation.

# 13. Final Recommendation

The proposed model should prioritize academic substance over terminology. Fundamental Subjects should contribute 30%, Core Subjects should contribute 50%, and Historical Data should contribute 20%. Degree Title and Keyword Match should not contribute to the risk percentage.

Most importantly, every risk percentage generated by the application should be traceable to these three factors and should provide a clear reason for the result. This will make the assessment more transparent, consistent, and easier for internal teams and clients to understand.
