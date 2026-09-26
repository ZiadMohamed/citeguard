"""Hand-written claims against fixtures/csr/docs.jsonl: (id, claim, table, label, errorType, why)."""
G, B = "supported", "not_supported"
ITEMS = [
 # --- good: faithful, including hedged and qualitative-but-true statements
 ("ok-hba1c-26", "At week 26, drug R reduced HbA1c by 0.94% compared with 0.28% on placebo (difference -0.66%, p < 0.001).", "14.2.1", G, "SUPPORTED", "exact"),
 ("ok-hba1c-all", "Drug R reduced HbA1c significantly more than placebo at every visit through week 52.", "14.2.1", G, "SUPPORTED", "p<0.001 at weeks 12, 26, 52"),
 ("ok-weight", "Body weight decreased by 2.1 kg with drug R and 0.6 kg with placebo at week 26.", "14.2.2", G, "SUPPORTED", "exact"),
 ("ok-target", "Nearly 40% of drug R patients reached HbA1c below 7.0% at week 26, versus about 22% on placebo.", "14.2.2", G, "SUPPORTED", "39.9 vs 21.8, approximate wording"),
 ("ok-sbp-hedged", "Systolic blood pressure fell numerically more with drug R, but the difference from placebo was not statistically significant (p = 0.247).", "14.2.2", G, "SUPPORTED", "hedged correctly"),
 ("ok-nausea", "Nausea was the most common adverse event with drug R, reported by 12.0% of patients versus 4.0% on placebo.", "14.3.2", G, "SUPPORTED", "largest PT row"),
 ("ok-discont", "More patients discontinued because of adverse events on drug R (6.0%) than on placebo (2.3%).", "14.3.1", G, "SUPPORTED", "exact"),
 ("ok-sae-similar", "Serious adverse events occurred at similar rates in the two groups (7.0% and 6.4%).", "14.3.1", G, "SUPPORTED", "similar is fair for 7.0 vs 6.4"),
 ("ok-baseline", "Baseline characteristics were balanced between groups; mean age was 61.2 and 60.8 years and mean HbA1c 8.3% and 8.2%.", "14.1.1", G, "SUPPORTED", "balanced is fair"),
 ("ok-egfr-sub", "The HbA1c reduction appeared smaller in patients with eGFR below 60 (difference -0.38%) than in those with eGFR of 60 or above (-0.72%).", "14.2.3", G, "SUPPORTED", "hedged 'appeared'"),
 ("ok-age-sub", "The treatment effect on HbA1c was consistent across age subgroups (interaction p = 0.61).", "14.2.3", G, "SUPPORTED", "consistent with non-sig interaction"),
 ("ok-hypo", "Hypoglycaemia (glucose below 54 mg/dL) was reported in 4.0% of patients on drug R and 1.0% on placebo.", "14.3.2", G, "SUPPORTED", "exact"),
 ("ok-alt", "Shifts in ALT to more than three times the upper limit of normal were rare (0.7% on drug R, 0.3% on placebo).", "14.3.3", G, "SUPPORTED", "rare is fair"),
 ("ok-fpg", "Fasting plasma glucose fell by 24.3 mg/dL on drug R versus 8.9 mg/dL on placebo at week 26.", "14.2.2", G, "SUPPORTED", "exact"),
 ("ok-death", "One patient on drug R and two on placebo died during the study.", "14.3.1", G, "SUPPORTED", "1 vs 2"),
]

ITEMS += [
 # --- qualitative safety overstatement (no numbers, or numbers that don't carry the error)
 ("q-well-tolerated", "Drug R was well tolerated, with an adverse event profile similar to placebo.", "14.3.1", B, "qualitative_safety", "drug-related 24.0 vs 13.8, discontinuation 6.0 vs 2.3, grade>=3 9.0 vs 6.0"),
 ("q-no-signal", "No safety signals were identified for hepatic or renal function.", "14.3.3", B, "qualitative_safety", "eGFR fell 2.9 vs 1.1; 'no signal' is a conclusion the table can't make"),
 ("q-hypo-no-increase", "Drug R did not increase the risk of hypoglycaemia.", "14.3.2", B, "qualitative_safety", "4.0% vs 1.0%"),
 ("q-gi-mild", "Gastrointestinal events were mild and transient.", "14.3.2", B, "not_in_source", "severity and duration aren't in the table"),
 ("q-safe-renal", "Drug R is safe in patients with renal impairment.", "14.3.1", B, "qualitative_safety", "table has no renal subgroup"),
 # --- subgroup / population errors
 ("s-egfr-consistent", "The HbA1c benefit of drug R was consistent across renal function subgroups.", "14.2.3", B, "subgroup_overreach", "interaction p = 0.04; eGFR<60 CI crosses 0"),
 ("s-egfr-sig", "In patients with eGFR below 60, drug R significantly reduced HbA1c versus placebo (difference -0.38%).", "14.2.3", B, "subgroup_overreach", "CI -0.77 to 0.01 includes 0"),
 ("s-age-greater", "Older patients (65 years and above) derived a significantly smaller benefit than younger patients.", "14.2.3", B, "subgroup_overreach", "interaction p=0.61"),
 ("s-population", "In the safety population, HbA1c fell by 0.94% at week 26.", "14.2.1", B, "population_swap", "table is full analysis set"),
 # --- time point / scope
 ("t-sustained", "The HbA1c reduction with drug R increased steadily through week 52.", "14.2.1", B, "timepoint_scope", "peaks at week 26 (-0.94) then -0.81"),
 ("t-weight-52", "At week 52, drug R reduced body weight by 2.1 kg.", "14.2.2", B, "timepoint_swap", "weight is week 26 only"),
 ("t-maximal-12", "The maximal HbA1c reduction was reached by week 12.", "14.2.1", B, "timepoint_scope", "max at week 26"),
 # --- significance / causation / certainty
 ("c-sbp-lowered", "Drug R also lowered systolic blood pressure compared with placebo.", "14.2.2", B, "comparison_nonsignificant", "p=0.247"),
 ("c-sbp-benefit", "Drug R provides an additional blood pressure benefit of 1.3 mmHg.", "14.2.2", B, "comparison_nonsignificant", "CI -3.5 to 0.9"),
 ("c-uti-caused", "Drug R caused urinary tract infections in 5.0% of patients.", "14.3.2", B, "causation", "5.0 vs 4.7 on placebo; incidence isn't causation"),
 ("c-weight-because", "Weight loss with drug R was driven by its gastrointestinal effects.", "14.2.2", B, "not_in_source", "mechanism not in table"),
 ("c-target-tripled", "Drug R tripled the proportion of patients reaching HbA1c below 7.0%.", "14.2.2", B, "magnitude", "39.9 vs 21.8 is about 1.8x"),
 # --- direction / arm / derived numbers
 ("d-headache", "Headache was more common with drug R than with placebo (3.7% vs 4.4%).", "14.3.2", B, "direction_flip", "3.7 < 4.4"),
 ("d-any-teae-arm", "Any adverse event was reported by 57.0% of drug R patients and 61.0% of placebo patients.", "14.3.1", B, "swap_values", "arms swapped"),
 ("d-egfr-increase", "eGFR increased slightly with drug R over 52 weeks.", "14.3.3", B, "direction_flip", "-2.9"),
 ("d-grade3-rel", "Grade 3 or higher adverse events were 50% more frequent with drug R (9.0% vs 6.0%), all of them drug-related.", "14.3.1", B, "not_in_source", "relatedness of grade 3 events not in table"),
 ("d-hct", "Haematocrit decreased with drug R.", "14.3.3", B, "direction_flip", "+1.9"),
]
