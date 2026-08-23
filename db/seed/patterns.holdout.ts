/**
 * SEALED HOLDOUT FRAUD PATTERNS
 * ==============================
 *
 * This file is authored and committed BEFORE any rule-engine code exists in this
 * repository. Check `git log --diff-filter=A -- db/seed/patterns.holdout.ts` against
 * the first commit touching `apps/api/src/household/rules.ts` — the ordering is the
 * entire point of this file and cannot be recreated after the fact.
 *
 * WHY THIS EXISTS
 * ---------------
 * A rule engine validated only against synthetic data generated to match its own
 * detection patterns proves internal consistency and nothing else. Every "we caught
 * 94% of fraud" claim built that way is circular.
 *
 * So the corpus is split in two:
 *
 *   patterns.known.ts    fraud patterns the rules are explicitly written against.
 *                        Recall here measures internal consistency — a floor, not a result.
 *
 *   patterns.holdout.ts  (this file) fraud behaviours authored without reference to any
 *                        detection logic, because none exists yet. Recall here is the
 *                        honest number: how much fraud the engine catches that it was
 *                        never built to catch.
 *
 * The gap between the two recall figures is this project's overfitting measure.
 *
 * RULES OF ENGAGEMENT
 * -------------------
 * 1. This file is not opened again until Week 5, when metrics are computed.
 * 2. No detection rule may be written or tuned in response to anything in here. If a
 *    holdout pattern is missed, that is a published result, not a bug to fix. Tuning
 *    against it destroys the only non-circular metric this project has.
 * 3. If a pattern here later becomes a rule the engine explicitly targets, it moves to
 *    patterns.known.ts and is removed from the holdout count. It does not get to be both.
 *
 * AUTHORING BASIS
 * ---------------
 * These are fraud *behaviours* reasoned from how income-certificate fraud is described in
 * the sources cited in PROJECT_REPORT.md §1 — certificate mills, bulk issuance, deliberate
 * identity fragmentation to defeat matching, and threshold gaming. They are deliberately
 * NOT a restatement of the five contradiction rules named in §5 Tier 1. Several are
 * expected to be missed entirely. That is the design.
 */

/** Annual household income ceiling for scholarship eligibility, in INR. */
export const SCHOLARSHIP_INCOME_CEILING = 250_000;

/** Application deadline for the synthetic admission cycle. */
export const CYCLE_DEADLINE = '2026-07-31';

export interface HoldoutApplication {
  /** Stable key within the case, used to assert which applications should be flagged. */
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
  /** Cycle label — some patterns only become visible across admission cycles. */
  cycle: string;
}

export interface HoldoutCase {
  id: string;
  /** The fraud behaviour in plain language. */
  behaviour: string;
  /**
   * Why this is expected to be hard for a contradiction-based engine. Recorded at
   * authoring time so the Week 5 analysis cannot be rationalised after seeing results.
   */
  evasion: string;
  /** Refs that a correct system should surface. Others in the case are context. */
  shouldFlag: string[];
  applications: HoldoutApplication[];
}

export const HOLDOUT_CASES: HoldoutCase[] = [
  {
    id: 'HO-01-address-rotation',
    behaviour:
      'One family claims across three admission cycles, using a different address each time so no two applications ever share a location. The guardian phone number is reused because it is the contact of record for the certificate.',
    evasion:
      'Defeats address-based clustering entirely. The only durable link is a contact field, which an address-and-name-oriented resolver may not weight at all.',
    shouldFlag: ['a2', 'a3'],
    applications: [
      {
        ref: 'a1',
        applicantName: 'Karthik Raman',
        guardianName: 'Raman Subramaniam',
        guardianPhone: '9840112233',
        addressLine: '14 Bharathi Street, Ayanavaram',
        district: 'Chennai',
        pincode: '600023',
        declaredAnnualIncome: 84_000,
        declaredFamilySize: 4,
        certificateId: 'TN-CHN-2024-118842',
        issuingOffice: 'Ayanavaram Taluk Office',
        certificateIssueDate: '2024-06-11',
        applicationDate: '2024-06-20',
        cycle: '2024',
      },
      {
        ref: 'a2',
        applicantName: 'Divya Raman',
        guardianName: 'Raman Subramaniam',
        guardianPhone: '9840112233',
        addressLine: '7/2 Kamaraj Nagar, Villivakkam',
        district: 'Chennai',
        pincode: '600049',
        declaredAnnualIncome: 79_000,
        declaredFamilySize: 4,
        certificateId: 'TN-CHN-2025-204471',
        issuingOffice: 'Villivakkam Taluk Office',
        certificateIssueDate: '2025-06-18',
        applicationDate: '2025-06-27',
        cycle: '2025',
      },
      {
        ref: 'a3',
        applicantName: 'Sanjay Raman',
        guardianName: 'Raman Subramaniam',
        guardianPhone: '9840112233',
        addressLine: '221 Perumal Koil Street, Perambur',
        district: 'Chennai',
        pincode: '600011',
        declaredAnnualIncome: 81_500,
        declaredFamilySize: 4,
        certificateId: 'TN-CHN-2026-311905',
        issuingOffice: 'Perambur Taluk Office',
        certificateIssueDate: '2026-06-09',
        applicationDate: '2026-06-22',
        cycle: '2026',
      },
    ],
  },

  {
    id: 'HO-02-threshold-bunching',
    behaviour:
      'Six unrelated applicants declare incomes bunched immediately below the eligibility ceiling — ₹2.41L–₹2.49L against a ₹2.5L cutoff. Genuine low-income declarations cluster far lower; this is threshold gaming.',
    evasion:
      'No pairwise contradiction exists anywhere. This is a distributional anomaly across the whole cycle, and a rule engine that only compares applications within a resolved household will never see it.',
    shouldFlag: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'],
    applications: [
      {
        ref: 'b1',
        applicantName: 'Praveen Kumar',
        guardianName: 'Kumar Anbazhagan',
        guardianPhone: '9791004411',
        addressLine: '18 Gandhi Road, Tambaram',
        district: 'Chengalpattu',
        pincode: '600045',
        declaredAnnualIncome: 248_000,
        declaredFamilySize: 5,
        certificateId: 'TN-CGL-2026-440112',
        issuingOffice: 'Tambaram Taluk Office',
        certificateIssueDate: '2026-05-14',
        applicationDate: '2026-06-02',
        cycle: '2026',
      },
      {
        ref: 'b2',
        applicantName: 'Sneha Balaji',
        guardianName: 'Balaji Venkatesh',
        guardianPhone: '9791225588',
        addressLine: '92 Nehru Nagar, Chromepet',
        district: 'Chengalpattu',
        pincode: '600044',
        declaredAnnualIncome: 246_500,
        declaredFamilySize: 4,
        certificateId: 'TN-CGL-2026-441038',
        issuingOffice: 'Tambaram Taluk Office',
        certificateIssueDate: '2026-05-16',
        applicationDate: '2026-06-04',
        cycle: '2026',
      },
      {
        ref: 'b3',
        applicantName: 'Arun Prakash',
        guardianName: 'Prakash Mani',
        guardianPhone: '9944337712',
        addressLine: '3 Anna Salai, Pallavaram',
        district: 'Chengalpattu',
        pincode: '600043',
        declaredAnnualIncome: 249_000,
        declaredFamilySize: 6,
        certificateId: 'TN-CGL-2026-442901',
        issuingOffice: 'Tambaram Taluk Office',
        certificateIssueDate: '2026-05-19',
        applicationDate: '2026-06-07',
        cycle: '2026',
      },
      {
        ref: 'b4',
        applicantName: 'Meena Sundar',
        guardianName: 'Sundar Rajan',
        guardianPhone: '9600441199',
        addressLine: '44 Station Road, Guduvancheri',
        district: 'Chengalpattu',
        pincode: '603202',
        declaredAnnualIncome: 241_000,
        declaredFamilySize: 5,
        certificateId: 'TN-CGL-2026-443377',
        issuingOffice: 'Tambaram Taluk Office',
        certificateIssueDate: '2026-05-21',
        applicationDate: '2026-06-09',
        cycle: '2026',
      },
      {
        ref: 'b5',
        applicantName: 'Vignesh Murugan',
        guardianName: 'Murugan Palani',
        guardianPhone: '9500886644',
        addressLine: '61 Bazaar Street, Selaiyur',
        district: 'Chengalpattu',
        pincode: '600073',
        declaredAnnualIncome: 247_200,
        declaredFamilySize: 4,
        certificateId: 'TN-CGL-2026-444120',
        issuingOffice: 'Tambaram Taluk Office',
        certificateIssueDate: '2026-05-23',
        applicationDate: '2026-06-11',
        cycle: '2026',
      },
      {
        ref: 'b6',
        applicantName: 'Lakshmi Narayanan',
        guardianName: 'Narayanan Iyer',
        guardianPhone: '9840771122',
        addressLine: '9 Temple Street, Medavakkam',
        district: 'Chengalpattu',
        pincode: '600100',
        declaredAnnualIncome: 244_800,
        declaredFamilySize: 5,
        certificateId: 'TN-CGL-2026-445006',
        issuingOffice: 'Tambaram Taluk Office',
        certificateIssueDate: '2026-05-26',
        applicationDate: '2026-06-13',
        cycle: '2026',
      },
    ],
  },

  {
    id: 'HO-03-guardian-name-fragmentation',
    behaviour:
      'Three siblings apply with the same father, but his name is written differently on each application — full name, initial-plus-surname, and a spelling variant — specifically to prevent the applications being linked. Incomes declared differ substantially.',
    evasion:
      'Directly attacks entity resolution rather than the contradiction rules. If normalisation and fuzzy matching are weak, the households never merge and no contradiction rule ever runs.',
    shouldFlag: ['c1', 'c2', 'c3'],
    applications: [
      {
        ref: 'c1',
        applicantName: 'Hariharan Muthusamy',
        guardianName: 'Muthusamy Govindaraj',
        guardianPhone: '9345112200',
        addressLine: '27 Kongu Nagar, Peelamedu',
        district: 'Coimbatore',
        pincode: '641004',
        declaredAnnualIncome: 96_000,
        declaredFamilySize: 5,
        certificateId: 'TN-CBE-2026-660214',
        issuingOffice: 'Coimbatore North Taluk Office',
        certificateIssueDate: '2026-06-02',
        applicationDate: '2026-06-15',
        cycle: '2026',
      },
      {
        ref: 'c2',
        applicantName: 'Gowri Muthusamy',
        guardianName: 'M. Govindaraj',
        guardianPhone: '9345112200',
        addressLine: '27 Kongu Nagar, Peelamedu',
        district: 'Coimbatore',
        pincode: '641004',
        declaredAnnualIncome: 178_000,
        declaredFamilySize: 5,
        certificateId: 'TN-CBE-2026-661885',
        issuingOffice: 'Coimbatore North Taluk Office',
        certificateIssueDate: '2026-06-05',
        applicationDate: '2026-06-18',
        cycle: '2026',
      },
      {
        ref: 'c3',
        applicantName: 'Bhuvana Muthuswamy',
        guardianName: 'Muthuswami Govindraj',
        guardianPhone: '9345112200',
        addressLine: '27 Kongu Nagar, Peelamedu',
        district: 'Coimbatore',
        pincode: '641004',
        declaredAnnualIncome: 92_500,
        declaredFamilySize: 6,
        certificateId: 'TN-CBE-2026-663402',
        issuingOffice: 'Coimbatore North Taluk Office',
        certificateIssueDate: '2026-06-07',
        applicationDate: '2026-06-21',
        cycle: '2026',
      },
    ],
  },

  {
    id: 'HO-04-certificate-serial-adjacency',
    behaviour:
      'Five applicants with no shared identity fields hold certificates with near-sequential serial numbers, all issued by one office within a single day — the signature of a bulk-issued batch obtained through an intermediary.',
    evasion:
      'The applicants are genuinely unrelated on every field a household resolver examines. The only shared artefact is the certificate serial sequence, which is document metadata, not applicant identity.',
    shouldFlag: ['d1', 'd2', 'd3', 'd4', 'd5'],
    applications: [
      {
        ref: 'd1',
        applicantName: 'Ramya Selvaraj',
        guardianName: 'Selvaraj Thangavel',
        guardianPhone: '9962004455',
        addressLine: '12 Mettu Street, Thanjavur',
        district: 'Thanjavur',
        pincode: '613001',
        declaredAnnualIncome: 72_000,
        declaredFamilySize: 4,
        certificateId: 'TN-TNJ-2026-700341',
        issuingOffice: 'Thanjavur Taluk Office',
        certificateIssueDate: '2026-06-12',
        applicationDate: '2026-06-24',
        cycle: '2026',
      },
      {
        ref: 'd2',
        applicantName: 'Vimal Chandran',
        guardianName: 'Chandran Pillai',
        guardianPhone: '9080117733',
        addressLine: '5 Sivaganga Road, Thanjavur',
        district: 'Thanjavur',
        pincode: '613007',
        declaredAnnualIncome: 72_000,
        declaredFamilySize: 5,
        certificateId: 'TN-TNJ-2026-700342',
        issuingOffice: 'Thanjavur Taluk Office',
        certificateIssueDate: '2026-06-12',
        applicationDate: '2026-06-25',
        cycle: '2026',
      },
      {
        ref: 'd3',
        applicantName: 'Nithya Ganesan',
        guardianName: 'Ganesan Ramalingam',
        guardianPhone: '9445228811',
        addressLine: '88 South Main Street, Kumbakonam',
        district: 'Thanjavur',
        pincode: '612001',
        declaredAnnualIncome: 72_000,
        declaredFamilySize: 4,
        certificateId: 'TN-TNJ-2026-700344',
        issuingOffice: 'Thanjavur Taluk Office',
        certificateIssueDate: '2026-06-12',
        applicationDate: '2026-06-26',
        cycle: '2026',
      },
      {
        ref: 'd4',
        applicantName: 'Suresh Kalyanam',
        guardianName: 'Kalyanam Subbu',
        guardianPhone: '9345667700',
        addressLine: '31 Big Street, Papanasam',
        district: 'Thanjavur',
        pincode: '614205',
        declaredAnnualIncome: 72_000,
        declaredFamilySize: 6,
        certificateId: 'TN-TNJ-2026-700347',
        issuingOffice: 'Thanjavur Taluk Office',
        certificateIssueDate: '2026-06-12',
        applicationDate: '2026-06-27',
        cycle: '2026',
      },
      {
        ref: 'd5',
        applicantName: 'Kavitha Rajendran',
        guardianName: 'Rajendran Natarajan',
        guardianPhone: '9600223344',
        addressLine: '7 East Car Street, Orathanadu',
        district: 'Thanjavur',
        pincode: '614625',
        declaredAnnualIncome: 72_000,
        declaredFamilySize: 5,
        certificateId: 'TN-TNJ-2026-700349',
        issuingOffice: 'Thanjavur Taluk Office',
        certificateIssueDate: '2026-06-12',
        applicationDate: '2026-06-28',
        cycle: '2026',
      },
    ],
  },

  {
    id: 'HO-05-recycled-certificate',
    behaviour:
      'One genuine certificate is submitted by two different applicants in the same cycle — the same certificate ID and issuing office, with the applicant name altered on the document.',
    evasion:
      'Requires the system to treat the certificate as an entity in its own right and detect reuse. A resolver built around applicant and household identity may never index certificate IDs for collision at all.',
    shouldFlag: ['e1', 'e2'],
    applications: [
      {
        ref: 'e1',
        applicantName: 'Deepak Anand',
        guardianName: 'Anand Krishnan',
        guardianPhone: '9840556677',
        addressLine: '19 Lake View Road, Madurai',
        district: 'Madurai',
        pincode: '625002',
        declaredAnnualIncome: 88_000,
        declaredFamilySize: 4,
        certificateId: 'TN-MDU-2026-810556',
        issuingOffice: 'Madurai South Taluk Office',
        certificateIssueDate: '2026-05-30',
        applicationDate: '2026-06-14',
        cycle: '2026',
      },
      {
        ref: 'e2',
        applicantName: 'Shalini Devi',
        guardianName: 'Devendran Marimuthu',
        guardianPhone: '9791889900',
        addressLine: '64 Tallakulam Main Road, Madurai',
        district: 'Madurai',
        pincode: '625002',
        declaredAnnualIncome: 88_000,
        declaredFamilySize: 4,
        certificateId: 'TN-MDU-2026-810556',
        issuingOffice: 'Madurai South Taluk Office',
        certificateIssueDate: '2026-05-30',
        applicationDate: '2026-06-19',
        cycle: '2026',
      },
    ],
  },

  {
    id: 'HO-06-family-size-inflation',
    behaviour:
      'A household declares a plausible income but inflates family size from four to nine, halving apparent per-capita income to clear a per-capita-based means test. The sibling application declares the true family size.',
    evasion:
      'Income figures do not contradict each other at all — only the denominators differ. A contradiction rule comparing declared household income across siblings sees perfect agreement.',
    shouldFlag: ['f1'],
    applications: [
      {
        ref: 'f1',
        applicantName: 'Ashwin Venkat',
        guardianName: 'Venkat Ramachandran',
        guardianPhone: '9500334422',
        addressLine: '108 Trichy Main Road, Salem',
        district: 'Salem',
        pincode: '636001',
        declaredAnnualIncome: 232_000,
        declaredFamilySize: 9,
        certificateId: 'TN-SLM-2026-905611',
        issuingOffice: 'Salem Taluk Office',
        certificateIssueDate: '2026-06-03',
        applicationDate: '2026-06-16',
        cycle: '2026',
      },
      {
        ref: 'f2',
        applicantName: 'Aparna Venkat',
        guardianName: 'Venkat Ramachandran',
        guardianPhone: '9500334422',
        addressLine: '108 Trichy Main Road, Salem',
        district: 'Salem',
        pincode: '636001',
        declaredAnnualIncome: 232_000,
        declaredFamilySize: 4,
        certificateId: 'TN-SLM-2026-906033',
        issuingOffice: 'Salem Taluk Office',
        certificateIssueDate: '2026-06-04',
        applicationDate: '2026-06-17',
        cycle: '2026',
      },
    ],
  },

  {
    id: 'HO-07-cross-cycle-income-collapse',
    behaviour:
      'A returning applicant declared ₹6.4L in the previous cycle and ₹94,000 in the current one, with no bereavement, no change of address, and the same guardian occupation.',
    evasion:
      'The contradiction is with the applicant\'s own history, not with a sibling. An engine that reconciles within an admission cycle will not look backwards across cycles at all.',
    shouldFlag: ['g2'],
    applications: [
      {
        ref: 'g1',
        applicantName: 'Rohit Ilango',
        guardianName: 'Ilango Perumal',
        guardianPhone: '9345009911',
        addressLine: '55 VOC Street, Tirunelveli',
        district: 'Tirunelveli',
        pincode: '627001',
        declaredAnnualIncome: 640_000,
        declaredFamilySize: 4,
        certificateId: 'TN-TVL-2025-330447',
        issuingOffice: 'Tirunelveli Taluk Office',
        certificateIssueDate: '2025-06-10',
        applicationDate: '2025-06-24',
        cycle: '2025',
      },
      {
        ref: 'g2',
        applicantName: 'Rohit Ilango',
        guardianName: 'Ilango Perumal',
        guardianPhone: '9345009911',
        addressLine: '55 VOC Street, Tirunelveli',
        district: 'Tirunelveli',
        pincode: '627001',
        declaredAnnualIncome: 94_000,
        declaredFamilySize: 4,
        certificateId: 'TN-TVL-2026-341902',
        issuingOffice: 'Tirunelveli Taluk Office',
        certificateIssueDate: '2026-06-08',
        applicationDate: '2026-06-20',
        cycle: '2026',
      },
    ],
  },

  {
    id: 'HO-08-contact-collision-distinct-households',
    behaviour:
      'Four applicants at four genuinely different addresses share one guardian phone number — the contact of a facilitator filing applications on their behalf for a fee.',
    evasion:
      'Addresses, names, and guardians are all distinct and legitimate. Only a low-salience contact field collides, and treating a shared phone as a household link risks false merges, so a cautious resolver may deliberately ignore it.',
    shouldFlag: ['h1', 'h2', 'h3', 'h4'],
    applications: [
      {
        ref: 'h1',
        applicantName: 'Bhavani Shankar',
        guardianName: 'Shankar Duraisamy',
        guardianPhone: '9994001122',
        addressLine: '2 Gandhi Nagar, Erode',
        district: 'Erode',
        pincode: '638001',
        declaredAnnualIncome: 76_000,
        declaredFamilySize: 5,
        certificateId: 'TN-ERD-2026-120334',
        issuingOffice: 'Erode Taluk Office',
        certificateIssueDate: '2026-06-01',
        applicationDate: '2026-06-23',
        cycle: '2026',
      },
      {
        ref: 'h2',
        applicantName: 'Manoj Sekar',
        guardianName: 'Sekar Ponnusamy',
        guardianPhone: '9994001122',
        addressLine: '41 Perundurai Road, Erode',
        district: 'Erode',
        pincode: '638011',
        declaredAnnualIncome: 81_000,
        declaredFamilySize: 4,
        certificateId: 'TN-ERD-2026-121557',
        issuingOffice: 'Erode Taluk Office',
        certificateIssueDate: '2026-06-02',
        applicationDate: '2026-06-23',
        cycle: '2026',
      },
      {
        ref: 'h3',
        applicantName: 'Priyanka Elangovan',
        guardianName: 'Elangovan Kandasamy',
        guardianPhone: '9994001122',
        addressLine: '17 Bhavani Main Road, Komarapalayam',
        district: 'Namakkal',
        pincode: '638183',
        declaredAnnualIncome: 79_500,
        declaredFamilySize: 6,
        certificateId: 'TN-NMK-2026-122801',
        issuingOffice: 'Namakkal Taluk Office',
        certificateIssueDate: '2026-06-03',
        applicationDate: '2026-06-24',
        cycle: '2026',
      },
      {
        ref: 'h4',
        applicantName: 'Sathish Kannan',
        guardianName: 'Kannan Velusamy',
        guardianPhone: '9994001122',
        addressLine: '90 Salem Road, Sankagiri',
        district: 'Salem',
        pincode: '637301',
        declaredAnnualIncome: 74_000,
        declaredFamilySize: 5,
        certificateId: 'TN-SLM-2026-123944',
        issuingOffice: 'Salem Taluk Office',
        certificateIssueDate: '2026-06-05',
        applicationDate: '2026-06-25',
        cycle: '2026',
      },
    ],
  },

  {
    id: 'HO-09-identical-round-income-mill',
    behaviour:
      'Eight applicants across three districts all declare exactly ₹72,000 — an implausibly round, identical figure repeated across supposedly independent family circumstances. The signature of a single template being reused.',
    evasion:
      'Each application is internally consistent and individually unremarkable. The anomaly is that a continuous quantity has zero variance across a population, which is a statistical property of the corpus rather than a fact about any application.',
    shouldFlag: ['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7', 'i8'],
    applications: [
      { ref: 'i1', applicantName: 'Ajay Thirumalai', guardianName: 'Thirumalai Raju', guardianPhone: '9840223311', addressLine: '3 Mount Road, Vellore', district: 'Vellore', pincode: '632001', declaredAnnualIncome: 72_000, declaredFamilySize: 4, certificateId: 'TN-VLR-2026-500112', issuingOffice: 'Vellore Taluk Office', certificateIssueDate: '2026-05-11', applicationDate: '2026-06-01', cycle: '2026' },
      { ref: 'i2', applicantName: 'Renuka Damodaran', guardianName: 'Damodaran Sivaraj', guardianPhone: '9791334455', addressLine: '22 Katpadi Road, Vellore', district: 'Vellore', pincode: '632007', declaredAnnualIncome: 72_000, declaredFamilySize: 5, certificateId: 'TN-VLR-2026-500887', issuingOffice: 'Vellore Taluk Office', certificateIssueDate: '2026-05-13', applicationDate: '2026-06-02', cycle: '2026' },
      { ref: 'i3', applicantName: 'Naveen Pandian', guardianName: 'Pandian Alagappan', guardianPhone: '9500118822', addressLine: '8 Bypass Road, Ranipet', district: 'Ranipet', pincode: '632401', declaredAnnualIncome: 72_000, declaredFamilySize: 4, certificateId: 'TN-RNP-2026-501339', issuingOffice: 'Ranipet Taluk Office', certificateIssueDate: '2026-05-15', applicationDate: '2026-06-04', cycle: '2026' },
      { ref: 'i4', applicantName: 'Swathi Manoharan', guardianName: 'Manoharan Ravi', guardianPhone: '9345771100', addressLine: '77 Arcot Road, Ranipet', district: 'Ranipet', pincode: '632403', declaredAnnualIncome: 72_000, declaredFamilySize: 6, certificateId: 'TN-RNP-2026-502004', issuingOffice: 'Ranipet Taluk Office', certificateIssueDate: '2026-05-18', applicationDate: '2026-06-06', cycle: '2026' },
      { ref: 'i5', applicantName: 'Gokul Srinivasan', guardianName: 'Srinivasan Baskar', guardianPhone: '9600552244', addressLine: '14 Church Street, Tiruvannamalai', district: 'Tiruvannamalai', pincode: '606601', declaredAnnualIncome: 72_000, declaredFamilySize: 5, certificateId: 'TN-TVM-2026-502771', issuingOffice: 'Tiruvannamalai Taluk Office', certificateIssueDate: '2026-05-20', applicationDate: '2026-06-08', cycle: '2026' },
      { ref: 'i6', applicantName: 'Yamini Chidambaram', guardianName: 'Chidambaram Natesan', guardianPhone: '9962118833', addressLine: '5 Polur Road, Tiruvannamalai', district: 'Tiruvannamalai', pincode: '606604', declaredAnnualIncome: 72_000, declaredFamilySize: 4, certificateId: 'TN-TVM-2026-503418', issuingOffice: 'Tiruvannamalai Taluk Office', certificateIssueDate: '2026-05-22', applicationDate: '2026-06-10', cycle: '2026' },
      { ref: 'i7', applicantName: 'Dinesh Arulmozhi', guardianName: 'Arulmozhi Sekaran', guardianPhone: '9080447711', addressLine: '36 Gandhi Street, Arni', district: 'Tiruvannamalai', pincode: '632301', declaredAnnualIncome: 72_000, declaredFamilySize: 5, certificateId: 'TN-TVM-2026-504102', issuingOffice: 'Tiruvannamalai Taluk Office', certificateIssueDate: '2026-05-25', applicationDate: '2026-06-12', cycle: '2026' },
      { ref: 'i8', applicantName: 'Harini Vasudevan', guardianName: 'Vasudevan Kuppusamy', guardianPhone: '9445660099', addressLine: '61 Bazaar Road, Cheyyar', district: 'Tiruvannamalai', pincode: '604407', declaredAnnualIncome: 72_000, declaredFamilySize: 4, certificateId: 'TN-TVM-2026-504889', issuingOffice: 'Tiruvannamalai Taluk Office', certificateIssueDate: '2026-05-27', applicationDate: '2026-06-14', cycle: '2026' },
    ],
  },

  {
    id: 'HO-10-deliberate-household-split',
    behaviour:
      'Two siblings present as unrelated households — different addresses, different declared guardian names (father on one, mother on the other), no shared phone. The link exists only in the certificate issuing office and near-identical issue dates.',
    evasion:
      'Every field a resolver uses to merge households has been deliberately severed. This is the adversarial limit case: it should probably be missed, and recording that honestly is more useful than pretending otherwise.',
    shouldFlag: ['j1', 'j2'],
    applications: [
      {
        ref: 'j1',
        applicantName: 'Aravind Jayakumar',
        guardianName: 'Jayakumar Nagarajan',
        guardianPhone: '9840990011',
        addressLine: '23 Kamban Street, Tiruchirappalli',
        district: 'Tiruchirappalli',
        pincode: '620001',
        declaredAnnualIncome: 89_000,
        declaredFamilySize: 4,
        certificateId: 'TN-TRY-2026-220145',
        issuingOffice: 'Tiruchirappalli West Taluk Office',
        certificateIssueDate: '2026-06-06',
        applicationDate: '2026-06-19',
        cycle: '2026',
      },
      {
        ref: 'j2',
        applicantName: 'Nandhini Rajeshwari',
        guardianName: 'Rajeshwari Jayakumar',
        guardianPhone: '9500221177',
        addressLine: '4 Thillai Nagar 2nd Cross, Tiruchirappalli',
        district: 'Tiruchirappalli',
        pincode: '620018',
        declaredAnnualIncome: 91_500,
        declaredFamilySize: 4,
        certificateId: 'TN-TRY-2026-220198',
        issuingOffice: 'Tiruchirappalli West Taluk Office',
        certificateIssueDate: '2026-06-06',
        applicationDate: '2026-06-20',
        cycle: '2026',
      },
    ],
  },
];

/** Total applications the holdout corpus contributes to the seed set. */
export const HOLDOUT_APPLICATION_COUNT = HOLDOUT_CASES.reduce(
  (n, c) => n + c.applications.length,
  0,
);

/** Applications a correct system should surface, used as the denominator for holdout recall. */
export const HOLDOUT_EXPECTED_FLAG_COUNT = HOLDOUT_CASES.reduce(
  (n, c) => n + c.shouldFlag.length,
  0,
);
