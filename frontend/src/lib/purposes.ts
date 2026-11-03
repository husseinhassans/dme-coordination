// Fact schemas from contract.py CALL_PURPOSES / ORDER_DOC_FACTS: the keys the LLM is
// asked to fill. Used to show "listening for…" rows before a fact arrives.
export const PURPOSE_FACTS: Record<string, [key: string, required: boolean][]> = {
  supplier_screen: [["accepting_new_medicare", true], ["accepts_assignment_all_months", true], ["k0001_in_stock", true], ["restock_days", false], ["serves_address", true], ["delivery_eta_days", true], ["accepts_referral", false], ["contact_name", false]],
  supplier_reconfirm: [["still_available", true], ["earliest_delivery", true], ["accepts_referral", false]],
  supplier_confirm: [["order_received", true], ["eligibility_clean", true], ["docs_sufficient", true], ["delivery_date", true]],
  supplier_delivery_check: [["delivered", true], ["proof_of_delivery", true], ["billed_hcpcs", true], ["on_assignment", false]],
  office_followup: [["request_received", true], ["owner_name", false], ["correct_fax", false], ["expected_signing", false]],
  office_correction: [["correction_accepted", true], ["clinical_disagreement", false]],
  patient_intro: [["address", true], ["mbi", true], ["prior_wheelchair", true], ["deductible_met", false], ["best_time", false]],
  patient_consent: [["consents_to_supplier", true], ["window_ok", true], ["cost_concern", false], ["declines", false], ["caregiver_present", false]],
  patient_delivery_check: [["delivered", true], ["cost_concern", false]],
};

export const ORDER_FACTS: [string, boolean][] = [
  ["beneficiary", true], ["mbi", false], ["description", true], ["hcpcs", true], ["quantity", true], ["practitioner", true], ["npi", false], ["order_date", true], ["signed", true],
  ["crit_A_mradl", true], ["crit_B_walker_not_enough", true], ["crit_C_home_access", true], ["crit_D_home_use", true], ["crit_E_willing", true], ["crit_FG_propel_or_caregiver", true],
];

export const HARD_FAIL_NOTE: Record<string, string> = {
  accepting_new_medicare: "hard fail if false",
  accepts_assignment_all_months: "hard fail if false (F9)",
  k0001_in_stock: "fail if out and restock > 14d",
  serves_address: "hard fail if false",
  delivery_eta_days: "fail if > 10 days",
  cost_concern: "true → PATIENT_COST_CONCERN",
  declines: "true → PATIENT_DECLINES",
  proof_of_delivery: "needed for DELIVERED (D11)",
  hcpcs: "must be K0001",
  quantity: "must be 1",
  signed: "required",
  safety_concern: "true → SAFETY_CONCERN",
};
