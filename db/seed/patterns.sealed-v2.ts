/**
 * SEALED HOLDOUT, SECOND SET
 * ===========================
 *
 * Authored after v4, against fraud mechanisms that NO rule in `rules.ts`
 * targets, and committed before any rule that might catch them exists. Check
 * `git log --diff-filter=A -- db/seed/patterns.sealed-v2.ts` against the first
 * commit introducing any v5 rule.
 *
 * WHY THIS SET CARRIES A WEAKER CLAIM THAN THE FIRST ONE
 * ------------------------------------------------------
 * `patterns.holdout.ts` was written before any rule-engine code existed at all,
 * by an author who could not have known what the engine would become. This file
 * was written by the same author, in the same sitting, as the v4 rules. The
 * separation is one of discipline rather than of ignorance: these mechanisms were
 * chosen *because* nothing in v4 addresses them, which is a deliberate act, not
 * an innocent one.
 *
 * That is a real weakness and it is stated here rather than discovered later. It
 * means this set can be read one way only — as a pre-registered baseline. Recall
 * measured against it TODAY, before any rule targets these mechanisms, is a clean
 * generalisation number: whatever the engine surfaces here, it surfaces by
 * generalising, because nothing was built for it. The moment a v5 rule targets
 * one of these, that case goes into `holdout-status.ts` and stops counting, the
 * same way the first set's cases did.
 *
 * RULES OF ENGAGEMENT (unchanged from the first set)
 * --------------------------------------------------
 * 1. No detection rule may be written or tuned in response to anything in here.
 * 2. A missed pattern is a published result, not a bug to fix.
 * 3. A pattern that becomes explicitly targeted is retired from the count.
 * 4. This file is never edited. Corrections happen by sealing a third set.
 *
 * AUTHORING BASIS
 * ---------------
 * Each mechanism below is an administrative or arithmetic implausibility that a
 * contradiction engine has no particular reason to notice: they involve one
 * application being internally odd, or odd against the calendar and the map,
 * rather than contradicting another application. v4's rules compare applications
 * to each other or to a population. None of them reads a date against a working
 * calendar, a PIN code against a district, or an income against a family size.
 */

/** Annual household income ceiling for scholarship eligibility, in INR. */
export const SCHOLARSHIP_INCOME_CEILING = 250_000;

/** Application deadline for the synthetic admission cycle. */
export const CYCLE_DEADLINE = '2026-07-31';

export interface SealedV2Application {
  ref: string;
  applicantName: string;
  guardianName: string;
  guardianPhone: string;
  addressLine: string;
  district: string;
  pincode: string;
  declaredAnnualIncome: number;
  declaredFamilySize: number;
  certificateId: string;
  issuingOffice: string;
  certificateIssueDate: string;
  applicationDate: string;
  cycle: string;
}

export interface SealedV2Case {
  id: string;
  behaviour: string;
  /** Why a contradiction engine has no particular reason to see this. */
  evasion: string;
  shouldFlag: string[];
  applications: SealedV2Application[];
}

export const SEALED_V2_CASES: SealedV2Case[] = [
  {
    id: 'S2-01-family-size-inflation-for-per-capita',
    behaviour:
      'A household declares a truthful total income of ₹2,10,000 but inflates family size from 4 to 9, because the committee reads per-capita income. Nothing contradicts anything: there is one application, one certificate, and the total is honest.',
    evasion:
      'Every income rule compares totals. A fabricated denominator leaves the numerator untouched, so no income comparison can see it, and with one application there is no sibling to disagree with.',
    shouldFlag: ['a1'],
    applications: [
      {
        ref: 'a1',
        applicantName: 'Vignesh Palanisamy',
        guardianName: 'Palanisamy Kandasamy',
        guardianPhone: '9042118876',
        addressLine: '12 Thiruvalluvar Street, Gandhipuram',
        district: 'Coimbatore',
        pincode: '641012',
        declaredAnnualIncome: 210_000,
        declaredFamilySize: 9,
        certificateId: 'TN-CBE-2026-771903',
        issuingOffice: 'Coimbatore South Taluk Office',
        certificateIssueDate: '2026-05-18',
        applicationDate: '2026-06-02',
        cycle: '2026',
      },
    ],
  },
  {
    id: 'S2-02-certificate-from-a-distant-office',
    behaviour:
      'An applicant living in Madurai holds an income certificate issued by a taluk office in Kanyakumari, 250km away, with a PIN code belonging to neither. The certificate is real; it was obtained where it was easiest to obtain.',
    evasion:
      'Office-based rules only ever compare one office against another WITHIN a household. A lone applicant whose office simply does not belong to their district is geographically absurd and arithmetically silent.',
    shouldFlag: ['b1'],
    applications: [
      {
        ref: 'b1',
        applicantName: 'Sathish Murugan',
        guardianName: 'Murugan Pandian',
        guardianPhone: '9629443311',
        addressLine: '45 Anna Nagar, Madurai',
        district: 'Madurai',
        pincode: '625020',
        declaredAnnualIncome: 128_000,
        declaredFamilySize: 5,
        certificateId: 'TN-KNY-2026-330447',
        issuingOffice: 'Agastheeswaram Taluk Office',
        certificateIssueDate: '2026-04-22',
        applicationDate: '2026-06-11',
        cycle: '2026',
      },
    ],
  },
  {
    id: 'S2-03-certificate-issued-on-a-closed-day',
    behaviour:
      'Three unrelated applicants hold certificates dated 26 January 2026 — Republic Day, when no taluk office issues anything. The documents are otherwise clean and internally consistent.',
    evasion:
      'Date handling in the engine is entirely relative: days before a deadline, ordering between certificates. Nothing reads a date against a working calendar, so an impossible issue date is just another Monday.',
    shouldFlag: ['c1', 'c2', 'c3'],
    applications: [
      {
        ref: 'c1',
        applicantName: 'Bhavani Selvaraj',
        guardianName: 'Selvaraj Thangavel',
        guardianPhone: '9840551209',
        addressLine: '3 Perumal Koil Street, Tambaram',
        district: 'Chennai',
        pincode: '600045',
        declaredAnnualIncome: 94_500,
        declaredFamilySize: 4,
        certificateId: 'TN-CHN-2026-418220',
        issuingOffice: 'Tambaram Taluk Office',
        certificateIssueDate: '2026-01-26',
        applicationDate: '2026-06-19',
        cycle: '2026',
      },
      {
        ref: 'c2',
        applicantName: 'Ramkumar Ilango',
        guardianName: 'Ilango Sundaram',
        guardianPhone: '9884330176',
        addressLine: '88 Kamarajar Salai, Chromepet',
        district: 'Chennai',
        pincode: '600044',
        declaredAnnualIncome: 143_200,
        declaredFamilySize: 6,
        certificateId: 'TN-CHN-2026-418994',
        issuingOffice: 'Tambaram Taluk Office',
        certificateIssueDate: '2026-01-26',
        applicationDate: '2026-06-24',
        cycle: '2026',
      },
      {
        ref: 'c3',
        applicantName: 'Nandhini Arumugam',
        guardianName: 'Arumugam Kaliyappan',
        guardianPhone: '9791220845',
        addressLine: '17 Bharathidasan Street, Pallavaram',
        district: 'Chennai',
        pincode: '600043',
        declaredAnnualIncome: 76_800,
        declaredFamilySize: 3,
        certificateId: 'TN-CHN-2026-419733',
        issuingOffice: 'Tambaram Taluk Office',
        certificateIssueDate: '2026-01-26',
        applicationDate: '2026-07-01',
        cycle: '2026',
      },
    ],
  },
  {
    id: 'S2-04-stale-certificate-reused-years-later',
    behaviour:
      'A certificate issued in 2021 is submitted against the 2026 cycle. It was truthful when issued; the household income has since risen well past the ceiling. No rule expires a document.',
    evasion:
      'DEADLINE_PROXIMITY looks for certificates obtained suspiciously LATE. A certificate obtained suspiciously early is the same field read the other way, and nothing reads it that way.',
    shouldFlag: ['d1'],
    applications: [
      {
        ref: 'd1',
        applicantName: 'Keerthana Rajendran',
        guardianName: 'Rajendran Chinnasamy',
        guardianPhone: '9445667712',
        addressLine: '62 Nehru Street, Salem',
        district: 'Salem',
        pincode: '636007',
        declaredAnnualIncome: 88_000,
        declaredFamilySize: 4,
        certificateId: 'TN-SLM-2021-102338',
        issuingOffice: 'Salem Taluk Office',
        certificateIssueDate: '2021-03-09',
        applicationDate: '2026-06-28',
        cycle: '2026',
      },
    ],
  },
  {
    id: 'S2-05-pincode-outside-declared-district',
    behaviour:
      'An applicant declares Tiruchirappalli as their district but gives a PIN code in the Nilgiris series. One of the two is false, and which one matters: district drives the verification link the reviewer opens.',
    evasion:
      'CERTIFICATE_DETAILS_MISMATCH compares the district and PIN on the form against the CERTIFICATE. When the applicant simply lies consistently on both, the two agree perfectly and the comparison passes.',
    shouldFlag: ['e1'],
    applications: [
      {
        ref: 'e1',
        applicantName: 'Aravind Kuppusamy',
        guardianName: 'Kuppusamy Natarajan',
        guardianPhone: '9360114528',
        addressLine: '9 Cauvery Nagar, Srirangam',
        district: 'Tiruchirappalli',
        pincode: '643001',
        declaredAnnualIncome: 119_400,
        declaredFamilySize: 5,
        certificateId: 'TN-TRY-2026-560118',
        issuingOffice: 'Srirangam Taluk Office',
        certificateIssueDate: '2026-05-30',
        applicationDate: '2026-07-04',
        cycle: '2026',
      },
    ],
  },
  {
    id: 'S2-06-one-phone-many-guardians-across-cycles',
    behaviour:
      'One handset appears across three cycles attached to three different guardian names at three different addresses — an agent filing on behalf of unrelated families for a fee, each application otherwise immaculate.',
    evasion:
      'SHARED_CONTACT_UNRELATED_HOUSEHOLDS compares applications within one cycle. Spread the same number across cycles and each cycle sees a single, unremarkable use of it.',
    shouldFlag: ['f1', 'f2', 'f3'],
    applications: [
      {
        ref: 'f1',
        applicantName: 'Yuvaraj Senthilkumar',
        guardianName: 'Senthilkumar Arunachalam',
        guardianPhone: '9976442180',
        addressLine: '21 Bazaar Street, Erode',
        district: 'Erode',
        pincode: '638001',
        declaredAnnualIncome: 102_000,
        declaredFamilySize: 4,
        certificateId: 'TN-ERD-2024-208814',
        issuingOffice: 'Erode Taluk Office',
        certificateIssueDate: '2024-05-14',
        applicationDate: '2024-06-20',
        cycle: '2024',
      },
      {
        ref: 'f2',
        applicantName: 'Priyadarshini Mohan',
        guardianName: 'Mohan Velusamy',
        guardianPhone: '9976442180',
        addressLine: '7 Gandhi Road, Bhavani',
        district: 'Erode',
        pincode: '638301',
        declaredAnnualIncome: 97_500,
        declaredFamilySize: 5,
        certificateId: 'TN-ERD-2025-241067',
        issuingOffice: 'Bhavani Taluk Office',
        certificateIssueDate: '2025-05-21',
        applicationDate: '2025-06-18',
        cycle: '2025',
      },
      {
        ref: 'f3',
        applicantName: 'Dinesh Karuppasamy',
        guardianName: 'Karuppasamy Ponnusamy',
        guardianPhone: '9976442180',
        addressLine: '134 Perundurai Main Road, Erode',
        district: 'Erode',
        pincode: '638052',
        declaredAnnualIncome: 110_300,
        declaredFamilySize: 4,
        certificateId: 'TN-ERD-2026-276559',
        issuingOffice: 'Erode Taluk Office',
        certificateIssueDate: '2026-05-09',
        applicationDate: '2026-06-27',
        cycle: '2026',
      },
    ],
  },
];
