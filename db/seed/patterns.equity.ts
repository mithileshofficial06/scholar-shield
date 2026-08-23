/**
 * LEGITIMATE-BUT-ANOMALOUS CASES
 * ==============================
 *
 * Applicants whose circumstances are irregular but not fraudulent. A triage
 * system whose subject is "which economically vulnerable applicants look
 * suspicious" will systematically flag these unless it is built not to
 * (PROJECT_REPORT.md §6).
 *
 * WHAT THE SUITE ASSERTS
 * ----------------------
 * Not "produces no flags" — that would be the wrong bar. A joint family really
 * does put several low-income households at one address, and surfacing that at
 * MEDIUM so a reviewer can clear it in ten seconds is the system working. What
 * must never happen is a HIGH-severity flag, because that is what pushes a
 * legitimate applicant to the top of a queue and frames them as a suspect.
 *
 * So: every case here may fire the rules listed in `toleratedRules`, at low or
 * medium severity. Any high-severity finding is a failure.
 *
 * AUTHORING BASIS AND ITS LIMIT
 * -----------------------------
 * These circumstances are drawn from documented situations — bereavement,
 * relocation, joint-family housing, migrant labour, remarriage, same-cycle
 * sibling filings — rather than invented for convenience, and the list is frozen
 * before rule weights are tuned.
 *
 * Stated plainly: these fixtures and the rules share an author. Passing this
 * suite proves the cases I anticipated are exempted, not that the system is fair.
 * That gap is narrowed by the sourcing above and closed by nothing short of
 * evaluation against real applicants, which this project cannot perform.
 */

import type { EquityCase } from './types.js';

export const EQUITY_CASES: EquityCase[] = [
  {
    id: 'E-01-joint-family-one-address',
    circumstance:
      'Three brothers and their families share one ancestral house. Each nuclear family files separately, and each is genuinely poor.',
    behaviour:
      'Three separately-resolved households at one address, all below the eligibility ceiling. Indistinguishable from collusion on address alone — which is why the address rule is capped at medium.',
    toleratedRules: ['ADDRESS_CLUSTER_UNRELATED'],
    applications: [
      {
        ref: 'a1',
        applicantName: 'Bhavani Shankar',
        guardianName: 'Shankar Duraisamy',
        guardianPhone: '9994001122',
        addressLine: '2 Gandhi Nagar',
        district: 'Erode',
        pincode: '638001',
        declaredAnnualIncome: 76_000,
        declaredFamilySize: 5,
        certificateId: 'TN-ERD-2026-120334',
        issuingOffice: 'Erode Taluk Office',
        certificateIssueDate: '2026-05-11',
        applicationDate: '2026-06-01',
        cycle: '2026',
      },
      {
        ref: 'a2',
        applicantName: 'Manoj Sekar',
        guardianName: 'Sekar Duraisamy',
        guardianPhone: '9080117733',
        addressLine: '2 Gandhi Nagar',
        district: 'Erode',
        pincode: '638001',
        declaredAnnualIncome: 81_000,
        declaredFamilySize: 4,
        certificateId: 'TN-ERD-2026-121557',
        issuingOffice: 'Erode Taluk Office',
        certificateIssueDate: '2026-05-13',
        applicationDate: '2026-06-02',
        cycle: '2026',
      },
      {
        ref: 'a3',
        applicantName: 'Priyanka Elangovan',
        guardianName: 'Elangovan Duraisamy',
        guardianPhone: '9445660099',
        addressLine: '2 Gandhi Nagar',
        district: 'Erode',
        pincode: '638001',
        declaredAnnualIncome: 74_500,
        declaredFamilySize: 6,
        certificateId: 'TN-ERD-2026-122801',
        issuingOffice: 'Erode Taluk Office',
        certificateIssueDate: '2026-05-15',
        applicationDate: '2026-06-03',
        cycle: '2026',
      },
    ],
  },

  {
    id: 'E-02-siblings-same-admission-cycle',
    circumstance:
      'Two siblings enter college in the same year and obtain their certificates in the same week, because that is when the family did the paperwork.',
    behaviour:
      'Certificates issued days apart with fully consistent incomes. The naive reading is "certificate shopping"; the actual reading is one trip to the taluk office.',
    toleratedRules: [],
    applications: [
      {
        ref: 'b1',
        applicantName: 'Ajay Thirumalai',
        guardianName: 'Thirumalai Raju',
        guardianPhone: '9840223311',
        addressLine: '3 Mount Road',
        district: 'Vellore',
        pincode: '632001',
        declaredAnnualIncome: 84_000,
        declaredFamilySize: 4,
        certificateId: 'TN-VLR-2026-500112',
        issuingOffice: 'Vellore Taluk Office',
        certificateIssueDate: '2026-06-10',
        applicationDate: '2026-06-24',
        cycle: '2026',
      },
      {
        ref: 'b2',
        applicantName: 'Renuka Thirumalai',
        guardianName: 'Thirumalai Raju',
        guardianPhone: '9840223311',
        addressLine: '3 Mount Road',
        district: 'Vellore',
        pincode: '632001',
        declaredAnnualIncome: 84_000,
        declaredFamilySize: 4,
        certificateId: 'TN-VLR-2026-500113',
        issuingOffice: 'Vellore Taluk Office',
        certificateIssueDate: '2026-06-12',
        applicationDate: '2026-06-24',
        cycle: '2026',
      },
    ],
  },

  {
    id: 'E-03-relocation-two-offices',
    circumstance:
      'The family moved districts between the two siblings applying. The second certificate necessarily came from a different taluk office.',
    behaviour:
      'One household, two issuing offices, consistent incomes. Weighted low precisely because relocation is ordinary.',
    toleratedRules: ['ISSUING_OFFICE_MISMATCH'],
    applications: [
      {
        ref: 'c1',
        applicantName: 'Vignesh Murugan',
        guardianName: 'Murugan Palani',
        guardianPhone: '9500886644',
        addressLine: '61 Bazaar Street, Selaiyur',
        district: 'Chengalpattu',
        pincode: '600073',
        declaredAnnualIncome: 97_000,
        declaredFamilySize: 4,
        certificateId: 'TN-CGL-2026-444120',
        issuingOffice: 'Tambaram Taluk Office',
        certificateIssueDate: '2026-04-18',
        applicationDate: '2026-06-11',
        cycle: '2026',
      },
      {
        ref: 'c2',
        applicantName: 'Lakshmi Murugan',
        guardianName: 'Murugan Palani',
        guardianPhone: '9500886644',
        addressLine: '61 Bazaar Street, Selaiyur',
        district: 'Chengalpattu',
        pincode: '600073',
        declaredAnnualIncome: 99_500,
        declaredFamilySize: 4,
        certificateId: 'TN-SLM-2026-445006',
        issuingOffice: 'Salem Taluk Office',
        certificateIssueDate: '2026-06-20',
        applicationDate: '2026-06-28',
        cycle: '2026',
      },
    ],
  },

  {
    id: 'E-04-minor-income-variation',
    circumstance:
      'Two certificates for one household issued four months apart, reflecting slightly different assessments of casual daily-wage earnings.',
    behaviour:
      '₹84,000 against ₹79,000 — a 6% difference on a low income. Real certificates for one household genuinely vary this much.',
    toleratedRules: [],
    applications: [
      {
        ref: 'd1',
        applicantName: 'Suresh Kalyanam',
        guardianName: 'Kalyanam Subbu',
        guardianPhone: '9345667700',
        addressLine: '31 Big Street, Papanasam',
        district: 'Thanjavur',
        pincode: '614205',
        declaredAnnualIncome: 84_000,
        declaredFamilySize: 6,
        certificateId: 'TN-TNJ-2026-700347',
        issuingOffice: 'Thanjavur Taluk Office',
        certificateIssueDate: '2026-02-12',
        applicationDate: '2026-06-27',
        cycle: '2026',
      },
      {
        ref: 'd2',
        applicantName: 'Kavitha Kalyanam',
        guardianName: 'Kalyanam Subbu',
        guardianPhone: '9345667700',
        addressLine: '31 Big Street, Papanasam',
        district: 'Thanjavur',
        pincode: '614205',
        declaredAnnualIncome: 79_000,
        declaredFamilySize: 6,
        certificateId: 'TN-TNJ-2026-700349',
        issuingOffice: 'Thanjavur Taluk Office',
        certificateIssueDate: '2026-06-14',
        applicationDate: '2026-06-28',
        cycle: '2026',
      },
    ],
  },

  {
    id: 'E-05-remarriage-different-guardians',
    circumstance:
      'Half-siblings living in different households after a remarriage. Each application names a different, correct guardian.',
    behaviour:
      'Shared surname, different guardians, different addresses. Must not be merged into one household — doing so would manufacture a contradiction from two honest filings.',
    toleratedRules: [],
    applications: [
      {
        ref: 'e1',
        applicantName: 'Sathish Kannan',
        guardianName: 'Kannan Velusamy',
        guardianPhone: '9994778811',
        addressLine: '90 Salem Road, Sankagiri',
        district: 'Salem',
        pincode: '637301',
        declaredAnnualIncome: 74_000,
        declaredFamilySize: 5,
        certificateId: 'TN-SLM-2026-123944',
        issuingOffice: 'Salem Taluk Office',
        certificateIssueDate: '2026-05-05',
        applicationDate: '2026-06-25',
        cycle: '2026',
      },
      {
        ref: 'e2',
        applicantName: 'Divya Kannan',
        guardianName: 'Rajeshwari Marimuthu',
        guardianPhone: '9791889900',
        addressLine: '64 Tallakulam Main Road',
        district: 'Madurai',
        pincode: '625002',
        declaredAnnualIncome: 198_000,
        declaredFamilySize: 3,
        certificateId: 'TN-MDU-2026-810912',
        issuingOffice: 'Madurai North Taluk Office',
        certificateIssueDate: '2026-05-22',
        applicationDate: '2026-06-26',
        cycle: '2026',
      },
    ],
  },

  {
    id: 'E-06-migrant-household-split-address',
    circumstance:
      'A migrant labour family whose address of record is the home village while the household actually lives near the work site. Two siblings gave different addresses, both truthfully.',
    behaviour:
      'Same guardian, same phone, different addresses, consistent incomes. Should resolve to one household on guardian plus phone, and find nothing wrong there.',
    toleratedRules: [],
    applications: [
      {
        ref: 'f1',
        applicantName: 'Gokul Srinivasan',
        guardianName: 'Srinivasan Baskar',
        guardianPhone: '9600552244',
        addressLine: '14 Church Street',
        district: 'Tiruvannamalai',
        pincode: '606601',
        declaredAnnualIncome: 72_000,
        declaredFamilySize: 5,
        certificateId: 'TN-TVM-2026-502771',
        issuingOffice: 'Tiruvannamalai Taluk Office',
        certificateIssueDate: '2026-05-20',
        applicationDate: '2026-06-08',
        cycle: '2026',
      },
      {
        ref: 'f2',
        applicantName: 'Yamini Srinivasan',
        guardianName: 'Srinivasan Baskar',
        guardianPhone: '9600552244',
        addressLine: '5 Polur Road',
        district: 'Tiruvannamalai',
        pincode: '606604',
        declaredAnnualIncome: 72_000,
        declaredFamilySize: 5,
        certificateId: 'TN-TVM-2026-503418',
        issuingOffice: 'Tiruvannamalai Taluk Office',
        certificateIssueDate: '2026-05-22',
        applicationDate: '2026-06-10',
        cycle: '2026',
      },
    ],
  },

  {
    id: 'E-07-tenement-near-deadline',
    circumstance:
      'A tenement building housing several poor families, who all filed late because the certificates took weeks to come through.',
    behaviour:
      'Address clustering AND deadline proximity together. This is the case that tests whether corroboration escalates severity — it must not. Two low-and-medium signals stay two low-and-medium signals.',
    toleratedRules: ['ADDRESS_CLUSTER_UNRELATED', 'DEADLINE_PROXIMITY'],
    applications: [
      {
        ref: 'g1',
        applicantName: 'Dinesh Arulmozhi',
        guardianName: 'Arulmozhi Sekaran',
        guardianPhone: '9080447711',
        addressLine: '36 Gandhi Street, Arni',
        district: 'Tiruvannamalai',
        pincode: '632301',
        declaredAnnualIncome: 68_000,
        declaredFamilySize: 5,
        certificateId: 'TN-TVM-2026-504102',
        issuingOffice: 'Tiruvannamalai Taluk Office',
        certificateIssueDate: '2026-07-22',
        applicationDate: '2026-07-30',
        cycle: '2026',
      },
      {
        ref: 'g2',
        applicantName: 'Harini Vasudevan',
        guardianName: 'Vasudevan Kuppusamy',
        guardianPhone: '9445660011',
        addressLine: '36 Gandhi Street, Arni',
        district: 'Tiruvannamalai',
        pincode: '632301',
        declaredAnnualIncome: 71_000,
        declaredFamilySize: 4,
        certificateId: 'TN-TVM-2026-504889',
        issuingOffice: 'Tiruvannamalai Taluk Office',
        certificateIssueDate: '2026-07-23',
        applicationDate: '2026-07-30',
        cycle: '2026',
      },
      {
        ref: 'g3',
        applicantName: 'Naveen Pandian',
        guardianName: 'Pandian Alagappan',
        guardianPhone: '9500118822',
        addressLine: '36 Gandhi Street, Arni',
        district: 'Tiruvannamalai',
        pincode: '632301',
        declaredAnnualIncome: 66_500,
        declaredFamilySize: 6,
        certificateId: 'TN-TVM-2026-505220',
        issuingOffice: 'Tiruvannamalai Taluk Office',
        certificateIssueDate: '2026-07-25',
        applicationDate: '2026-07-31',
        cycle: '2026',
      },
    ],
  },
];

export const EQUITY_APPLICATION_COUNT = EQUITY_CASES.reduce(
  (n, c) => n + c.applications.length,
  0,
);
