/**
 * Anonymised polytechnic transcript layouts (National Certificate and National
 * Diploma). Student name, candidate number, dates, and contact details are
 * placeholders. The layout follows the OCR text: letterhead in capitals,
 * "PROGRAMME ATTENDED:" (glued after a date on the diploma), and an
 * "AWARD / GRANTED" block with the award on the next line.
 */

export const POLY_CERTIFICATE_TEXT = [
  "--- page 1 ---",
  "HARARE POLYTECHNIC",
  "MINISTRY OF HIGHER AND TERTIARY EDUCATION, ZIMBABWE",
  "SAMPLE ROAD, BOX 000 SAMPLE TOWN. PHONE 000 000 - 00 FAX 000000",
  "ACADEMIC TRANSCRIPT",
  "STUDENT: SAMPLE STUDENT",
  "PROGRAMME ATTENDED: NATIONAL CERTIFICATE IN CIVIL ENGINEERING",
  "CANDIDATE NO: 0000000X00000 NOVEMBER 2000",
  "MONTH SUBJECT SUBJECT | GRADE",
  "& YEAR CODE | (SEE",
  "01/2000 100/S01 INTRODUCTION TO COMPUTERS 01/2000 100/S02 TECHNICAL COMMUNICATION | P",
  "01/2000 100/S03 ENGINEERING MATHEMATICS I | C",
  "01/2000 100/S04 ENGINEERING SURVEYING I | C",
  "All subjects are taught in English",
  "AWARD",
  "GRANTED",
  "NATIONAL CERTIFICATE IN CIVIL ENGINEERING",
  "KEY",
  "MARK RANGE 75-100 | 60 -74 50 - 59 | 0-49 GRADE | D | C | P | E | F Distinction Credit Pass Exempt Fail",
  "HEAD OF DEPARTMENT PRINCIPAL",
  "NAME | SIGNATURE | NAME SIGNATURE DATE",
  "HARARE POLYTECHNIC CIVIL ENGINEERING | PRINCIPAL",
].join("\n");

export const POLY_DIPLOMA_TEXT = [
  "--- page 1 ---",
  "HARARE POLYTECHNIC",
  "Sample Rd/Sample Avenue,MINISTRY OF HIGHER AND TERTIARY EDUCATION, Telephone: +000 0 0000000SCIENCE AND TECHNOLOGY DEVELOPMENT Email office@example.org P. O. Box 000, Sample Town Web site: www.example.org Harare. Zimbabwe",
  "ACADEMIC TRANSCRIPT",
  "STUDENT: SAMPLE STUDENT",
  "CANDIDATE NO: 0000000X00000 APRIL 2000PROGRAMME ATTENDED: NATIONAL DIPLOMA IN CIVIL ENGINEERING",
  "MONTH SUBJECT SUBJECT | GRADE& YEAR CODE | (SEE",
  "KEY)",
  "01/2000 200/S01 SOIL MECHANICS | P",
  "01/2000 200/S02 THEORY OF STRUCTURES 1 | C",
  "01/2000 200/S03 FLUID MECHANICS | P",
  "01/2000 200/S04 ON THE JOB TRAINING | D",
  "All subjects are taught in English",
  "AWARD",
  "GRANTED",
  "NATIONAL DIPLOMA IN CIVIL ENGINEERING",
  "KEY",
  "MARK RANGE Distinction 75-100 Credit 60 - 74 50 - 59 Pass Exempt 0-49 Fail GRADE | D | C | P | E | F",
].join("\n");

/** One transcript that prints a diploma and a bachelor award (strict case). */
export const MULTI_AWARD_TEXT = [
  "SAMPLE UNIVERSITY",
  "ACADEMIC RECORD",
  "Diploma in Civil Engineering completed 2018",
  "Bachelor of Engineering in Civil Engineering completed 2021",
].join("\n");
