/**
 * Multi-degree case fixtures for regression + isolation tests.
 * Institutions use "Name University" form so heuristicsInstitution matches
 * (generic "University of X" is not covered by the current patterns).
 */

export const FIXTURE_BACHELOR_ONLY = {
  id: "single-bachelor",
  selectedDegreeLevels: ["bachelor"] as const,
  cv: `
EDUCATION
B.Sc. Computer Science | Monash University | 2019
Australia
`,
  docs: [
    {
      type: "TRANSCRIPT" as const,
      degreeLevel: "bachelor" as const,
      text: `
OFFICIAL TRANSCRIPT
Bachelor of Science in Computer Science
Monash University
Australia
Duration: 3 years
`,
    },
    {
      type: "CERTIFICATE" as const,
      degreeLevel: "bachelor" as const,
      text: `
CERTIFICATE
This is to certify that the graduate was awarded
Bachelor of Science in Computer Science
by Monash University, Australia
`,
    },
  ],
};

export const FIXTURE_BACHELOR_MASTER = {
  id: "bachelor-master",
  selectedDegreeLevels: ["bachelor", "master"] as const,
  cv: `
EDUCATION
M.Sc. Data Science | National University of Singapore | 2022
Singapore
B.Eng. Software | Macquarie University | 2019
Australia
`,
  docs: [
    {
      type: "TRANSCRIPT" as const,
      degreeLevel: "bachelor" as const,
      text: `
TRANSCRIPT — Bachelor of Engineering in Software
Macquarie University
Australia
2016-2019
`,
    },
    {
      type: "CERTIFICATE" as const,
      degreeLevel: "bachelor" as const,
      text: `
CERTIFICATE — Bachelor of Engineering in Software
Macquarie University, Australia
`,
    },
    {
      type: "TRANSCRIPT" as const,
      degreeLevel: "master" as const,
      text: `
TRANSCRIPT — Master of Science in Data Science
National University of Singapore
Singapore
2020-2022
`,
    },
    {
      type: "CERTIFICATE" as const,
      degreeLevel: "master" as const,
      text: `
CERTIFICATE — Master of Science in Data Science
National University of Singapore, Singapore
`,
    },
  ],
};

export const FIXTURE_BACHELOR_MASTER_PHD = {
  id: "bachelor-master-phd",
  selectedDegreeLevels: ["bachelor", "master", "phd"] as const,
  cv: `
EDUCATION
PhD Artificial Intelligence | Massachusetts Institute of Technology | 2024
United States
M.Sc. Computer Science | Stanford University | 2020
United States
B.Sc. Mathematics | McGill University | 2018
Canada
`,
  docs: [
    {
      type: "TRANSCRIPT" as const,
      degreeLevel: "bachelor" as const,
      text: `
TRANSCRIPT — Bachelor of Science in Mathematics
McGill University
Canada
`,
    },
    {
      type: "CERTIFICATE" as const,
      degreeLevel: "bachelor" as const,
      text: `
CERTIFICATE — Bachelor of Science in Mathematics
McGill University, Canada
`,
    },
    {
      type: "TRANSCRIPT" as const,
      degreeLevel: "master" as const,
      text: `
TRANSCRIPT — Master of Science in Computer Science
Stanford University
United States
`,
    },
    {
      type: "CERTIFICATE" as const,
      degreeLevel: "master" as const,
      text: `
CERTIFICATE — Master of Science in Computer Science
Stanford University, United States
`,
    },
    {
      type: "TRANSCRIPT" as const,
      degreeLevel: "phd" as const,
      text: `
TRANSCRIPT — PhD in Artificial Intelligence
Massachusetts Institute of Technology
United States
`,
    },
    {
      type: "CERTIFICATE" as const,
      degreeLevel: "phd" as const,
      text: `
CERTIFICATE — PhD in Artificial Intelligence
Massachusetts Institute of Technology, United States
`,
    },
  ],
};

export const ALL_MULTI_DEGREE_FIXTURES = [
  FIXTURE_BACHELOR_ONLY,
  FIXTURE_BACHELOR_MASTER,
  FIXTURE_BACHELOR_MASTER_PHD,
] as const;
