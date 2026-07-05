export const SECTION_ALIASES = {
  subject: [
    "SubjectProperty",
    "Subject",
    "PropertySubject",
    "SubjectPropertyData",
    "SubjectRealEstate",
    "SUBJECT",
    "PROPERTY"
  ],
  comparable: [
    "ComparableSale",
    "Comparable",
    "Comp",
    "SaleComparable",
    "ComparableProperty",
    "COMPARABLE",
    "SALE",
    "COMP"
  ],
  reconciliation: [
    "Reconciliation",
    "ValueConclusion",
    "FinalValue",
    "OpinionOfValue",
    "ReconciliationSection",
    "RECONCILIATION",
    "VALUE_CONCLUSION"
  ],
  market: ["Market", "NeighborhoodMarket", "MarketConditions", "Neighborhood", "MARKET", "NEIGHBORHOOD"],
  comments: ["Comments", "AppraiserComments", "Narratives", "Commentary", "COMMENTS", "ADDENDUM"]
} as const;

export const GRID_ROW_ALIASES = {
  "subject.condition": [
    "condition",
    "condition rating",
    "overall condition",
    "property condition",
    "actual condition"
  ],
  "subject.quality": [
    "quality",
    "quality rating",
    "construction quality",
    "quality of construction"
  ],
  "comparables.condition": [
    "condition",
    "condition rating",
    "overall condition",
    "property condition",
    "actual condition"
  ],
  "comparables.quality": [
    "quality",
    "quality rating",
    "construction quality",
    "quality of construction"
  ],
  "comparables.gla_sqft": [
    "gross living area",
    "gla",
    "above grade living area",
    "gross living area sq ft",
    "gross living area square feet",
    "gla sq ft",
    "living area",
    "square footage"
  ],
  "comparables.sale_date": [
    "sale date",
    "date of sale",
    "contract date",
    "settlement date",
    "closed date"
  ],
  "comparables.sale_date_raw": ["date of sale", "sale date raw", "settlement date raw"],
  "comparables.contract_date": ["contract date", "contract date raw"],
  "comparables.adjusted_sale_price": [
    "adjusted sale price",
    "adjusted value",
    "indicated value",
    "net adjusted sale price",
    "sales price adjusted",
    "adjusted sales price of comparable"
  ],
  "comparables.sale_price": ["sale price", "sales price", "contract price"],
  "comparables.sales_price_per_gla": ["sales price per gross living area", "sale price per gla", "price per square foot"],
  "comparables.net_adjustment": ["net adjustment", "net adjusted", "net adjustment amount"],
  "comparables.net_adjustment_percent": ["net adjustment percent", "net adjustment %"],
  "comparables.gross_adjustment": ["gross adjustment", "gross adjusted", "gross adjustment amount"],
  "comparables.gross_adjustment_percent": ["gross adjustment percent", "gross adjustment %"],
  "comparables.property_rights": ["property rights", "rights appraised"],
  "comparables.sales_concessions": ["sales concessions", "sale concessions"],
  "comparables.financing_concessions": ["financing concessions", "sale or financing concessions", "sale financing concessions"],
  "comparables.total_rooms": ["rooms", "room count", "total room count", "above grade room count"],
  "comparables.bedrooms": ["bedrooms", "bedroom count", "beds"],
  "comparables.bathrooms": ["bathrooms", "bathroom count", "baths"],
  "comparables.full_bathrooms": ["full baths", "full bathrooms"],
  "comparables.half_bathrooms": ["half baths", "half bathrooms"],
  "comparables.year_built": ["actual age", "year built", "built year"],
  "comparables.actual_age": ["actual age", "age", "effective age"],
  "comparables.site_size": ["site", "site size", "lot size"],
  "comparables.view": ["view"],
  "comparables.location": ["location"],
  "comparables.design_style": ["design", "design style", "style", "design appeal"],
  "comparables.basement_area_sqft": ["basement", "basement area", "below grade area"],
  "comparables.basement_finished_sqft": ["finished basement area", "basement finished area", "below grade finished area"],
  "comparables.basement_description": ["basement", "basement description", "below grade description"],
  "comparables.basement_finish": ["basement finish", "below grade finish"],
  "comparables.functional_utility": ["functional utility"],
  "comparables.heating_cooling": ["heating cooling", "heating/cooling", "heat cool"],
  "comparables.energy_efficient": ["energy efficient", "energy items"],
  "comparables.garage_carport": ["car storage", "garage", "garage carport", "carport"],
  "comparables.garage_spaces": ["garage spaces", "garage count", "garage car count"],
  "comparables.carport_spaces": ["carport spaces", "carport count", "carport car count"],
  "comparables.porch_deck": ["porch deck", "porch/deck", "porch", "deck", "patio"],
  "comparables.fireplaces": ["fireplace", "fireplaces"]
} as const;

export const FIELD_ALIASES = {
  "metadata.report_type": [
    "ReportType",
    "AppraisalReportType",
    "ReportForm",
    "FormName",
    "USPAPReportDescription",
    "REPORT_TYPE"
  ],
  "metadata.form_type": ["FormType", "Form", "AppraisalFormType", "UADFormType", "AppraisalFormType", "FORM_TYPE"],
  "metadata.loan_purpose": ["LoanPurpose", "PurposeOfLoan", "MortgagePurpose", "LOAN_PURPOSE"],
  "metadata.appraisal_purpose": ["AppraisalPurpose", "Purpose", "IntendedUse", "APPRAISAL_PURPOSE"],
  "metadata.effective_date": [
    "EffectiveDate",
    "DateOfValue",
    "ValuationDate",
    "AppraisalEffectiveDate",
    "EFFECTIVE_DATE",
    "DATE_OF_VALUE"
  ],
  "metadata.inspection_date": ["InspectionDate", "PropertyInspectionDate", "INSPECTION_DATE"],
  "metadata.report_date": ["ReportDate", "SignatureDate", "AppraisalReportDate", "AppraiserReportSignedDate", "REPORT_DATE"],

  "subject.property_type": [
    "Subject.PropertyType",
    "PropertyType",
    "PropertySubType",
    "ResidentialPropertyType",
    "PROPERTY_TYPE"
  ],
  "subject.address_redacted": [
    "Subject.StreetAddress",
    "StreetAddress",
    "PropertyAddress",
    "Address",
    "AddressLine1",
    "Street",
    "STREET_ADDRESS",
    "PROPERTY_ADDRESS"
  ],
  "subject.city": ["Subject.City", "City", "PropertyCity", "CITY"],
  "subject.state": ["Subject.State", "State", "StateCode", "PropertyState", "STATE"],
  "subject.postal_code_redacted": ["Subject.PostalCode", "PostalCode", "ZipCode", "ZIP", "Zip", "POSTAL_CODE"],
  "subject.county": ["Subject.County", "County", "CountyName", "COUNTY"],
  "subject.neighborhood": ["Subject.Neighborhood", "Neighborhood", "NeighborhoodName", "MarketArea", "NEIGHBORHOOD"],
  "subject.site_size": [
    "Subject.SiteSize",
    "SiteSize",
    "LotSize",
    "SiteArea",
    "LandArea",
    "_AreaDescription",
    "SITE_SIZE",
    "LOT_SIZE"
  ],
  "subject.gla_sqft": [
    "Subject.GrossLivingArea",
    "Subject.GLA",
    "Property.GLA",
    "Improvements.GrossLivingArea",
    "GrossLivingArea",
    "LivingArea",
    "GrossLivingAreaSquareFeet",
    "GrossLivingAreaSquareFeetCount",
    "GROSS_LIVING_AREA",
    "GLA"
  ],
  "subject.bedrooms": ["Subject.Bedrooms", "Bedrooms", "BedroomCount", "Beds", "TotalBedroomCount", "BEDROOMS"],
  "subject.bathrooms": ["Subject.Bathrooms", "Bathrooms", "BathroomCount", "Baths", "TotalBathroomCount", "BATHROOMS"],
  "subject.year_built": [
    "Subject.YearBuilt",
    "YearBuilt",
    "ActualAgeYearBuilt",
    "BuiltYear",
    "PropertyStructureBuiltYear",
    "YEAR_BUILT"
  ],
  "subject.condition": ["Subject.Condition", "Condition", "PropertyCondition", "UADConditionRating", "CONDITION"],
  "subject.quality": ["Subject.Quality", "Quality", "QualityRating", "UADQualityRating", "QUALITY"],
  "subject.view": ["Subject.View", "View", "ViewDescription", "VIEW"],
  "subject.design_style": ["Subject.DesignStyle", "DesignStyle", "Style", "Design", "DESIGN_STYLE"],
  "subject.basement": ["Subject.Basement", "Basement", "BasementDescription", "BASEMENT"],
  "subject.garage_carport": ["Subject.GarageCarport", "GarageCarport", "Garage", "CarStorage", "Parking", "GARAGE"],

  "market.market_conditions": [
    "Market.MarketConditions",
    "MarketConditions",
    "MarketCondition",
    "NeighborhoodMarketConditions",
    "_MarketConditionsDescription",
    "MARKET_CONDITIONS"
  ],
  "market.marketing_time": ["Market.MarketingTime", "MarketingTime", "ExposureTime", "_TypicalMarketingTimeDurationType", "MARKETING_TIME"],
  "market.neighborhood_price_trend": [
    "Market.NeighborhoodPriceTrend",
    "NeighborhoodPriceTrend",
    "PriceTrend",
    "PropertyValuesTrend",
    "_PropertyValueTrendType",
    "PRICE_TREND"
  ],
  "market.supply_demand": ["Market.SupplyDemand", "SupplyDemand", "DemandSupply", "HousingSupply", "SUPPLY_DEMAND"],
  "market.location_description": [
    "Market.LocationDescription",
    "LocationDescription",
    "NeighborhoodDescription",
    "Location",
    "LOCATION_DESCRIPTION"
  ],

  "comparables.comp_id": ["CompId", "ComparableId", "Sequence", "Number", "PropertySequenceIdentifier", "COMP_ID"],
  "comparables.address_redacted": [
    "Comparable.StreetAddress",
    "StreetAddress",
    "PropertyAddress",
    "Address",
    "AddressLine1",
    "Street",
    "PropertyStreetAddress",
    "STREET_ADDRESS"
  ],
  "comparables.city": ["City", "PropertyCity", "CITY"],
  "comparables.state": ["State", "StateCode", "PropertyState", "STATE"],
  "comparables.postal_code_redacted": ["PostalCode", "ZipCode", "ZIP", "Zip", "PropertyPostalCode", "POSTAL_CODE"],
  "comparables.distance_miles": [
    "DistanceMiles",
    "Distance",
    "ProximityToSubject",
    "ProximityToSubjectDescription",
    "DISTANCE"
  ],
  "comparables.property_rights": ["PropertyRights", "PropertyRightsAppraised", "RightsAppraised", "PROPERTY_RIGHTS"],
  "comparables.sale_price": ["SalePrice", "Price", "SalesPrice", "ContractPrice", "PropertySalesAmount", "SALE_PRICE"],
  "comparables.sales_price_per_gla": [
    "SalesPricePerGrossLivingAreaAmount",
    "SalePricePerGrossLivingArea",
    "SalePricePerGLA",
    "SALE_PRICE_PER_GLA"
  ],
  "comparables.sale_date": ["SaleDate", "ClosedDate", "ContractDate", "PropertySalesDate", "GSEShortDateDescription", "SALE_DATE"],
  "comparables.sale_date_raw": ["DateOfSale", "DateOfSaleTime", "SaleDateTime", "DATE_OF_SALE"],
  "comparables.contract_date": ["ContractDate", "GSEContractDate", "CONTRACT_DATE"],
  "comparables.sales_concessions": ["SalesConcessions", "SaleConcessions", "SALE_CONCESSIONS"],
  "comparables.financing_concessions": [
    "FinancingConcessions",
    "SaleOrFinancingConcessions",
    "GSEFinancingType",
    "FINANCING_CONCESSIONS"
  ],
  "comparables.data_source": [
    "DataSource",
    "SaleDataSource",
    "MLS",
    "ListingSource",
    "DataSourceDescription",
    "GSEDataSourceDescription",
    "DATA_SOURCE"
  ],
  "comparables.verification_source": [
    "VerificationSource",
    "Verification",
    "VerifiedBy",
    "DataSourceVerificationDescription",
    "VERIFICATION_SOURCE"
  ],
  "comparables.gla_sqft": [
    "Comparable.GrossLivingArea",
    "Comparable.GLA",
    "GLA",
    "GrossLivingArea",
    "LivingArea",
    "GrossLivingAreaSquareFeet",
    "GROSS_LIVING_AREA"
  ],
  "comparables.total_rooms": ["TotalRoomCount", "RoomCount", "Rooms", "TOTAL_ROOMS"],
  "comparables.bedrooms": ["Bedrooms", "BedroomCount", "Beds", "TotalBedroomCount", "BEDROOMS"],
  "comparables.bathrooms": ["Bathrooms", "BathroomCount", "Baths", "TotalBathroomCount", "BATHROOMS"],
  "comparables.full_bathrooms": ["FullBathroomCount", "FullBaths", "FULL_BATHROOMS"],
  "comparables.half_bathrooms": ["HalfBathroomCount", "HalfBaths", "HALF_BATHROOMS"],
  "comparables.year_built": ["YearBuilt", "ActualAgeYearBuilt", "BuiltYear", "YEAR_BUILT"],
  "comparables.actual_age": ["ActualAge", "Age", "EffectiveAge", "ACTUAL_AGE"],
  "comparables.condition": ["Condition", "PropertyCondition", "UADConditionRating", "GSEOverallConditionType", "CONDITION"],
  "comparables.quality": [
    "Quality",
    "QualityRating",
    "UADQualityRating",
    "GSEQualityOfConstructionRatingType",
    "QUALITY"
  ],
  "comparables.site_size": ["SiteSize", "LotSize", "SiteArea", "LandArea", "SITE_SIZE"],
  "comparables.view": ["View", "ViewDescription", "VIEW"],
  "comparables.location": ["Location", "LocationDescription", "LOCATION"],
  "comparables.design_style": ["DesignStyle", "DesignAppeal", "Design", "_DesignDescription", "DESIGN_STYLE"],
  "comparables.basement_area_sqft": ["BasementArea", "GSEBelowGradeTotalSquareFeetNumber", "BASEMENT_AREA"],
  "comparables.basement_description": ["BasementArea", "BasementDescription", "BASEMENT_DESCRIPTION"],
  "comparables.basement_finished_sqft": ["BasementFinishArea", "GSEBelowGradeFinishSquareFeetNumber", "BASEMENT_FINISHED_AREA"],
  "comparables.basement_finish": ["BasementFinish", "BasementFinishDescription", "BASEMENT_FINISH"],
  "comparables.functional_utility": ["FunctionalUtility", "FunctionalUtilityDescription", "FUNCTIONAL_UTILITY"],
  "comparables.heating_cooling": ["HeatingCooling", "HeatingCoolingDescription", "HEATING_COOLING"],
  "comparables.energy_efficient": ["EnergyEfficient", "EnergyEfficientDescription", "ENERGY_EFFICIENT"],
  "comparables.garage_carport": ["CarStorage", "GarageCarport", "Garage", "Carport", "CAR_STORAGE"],
  "comparables.garage_spaces": ["GarageSpaces", "GarageCount", "GarageCarCount", "GARAGE_SPACES"],
  "comparables.carport_spaces": ["CarportSpaces", "CarportCount", "CarportCarCount", "CARPORT_SPACES"],
  "comparables.porch_deck": ["PorchDeck", "Porch", "Deck", "Patio", "PORCH_DECK"],
  "comparables.fireplaces": ["Fireplace", "Fireplaces", "FireplaceDescription", "FIREPLACE"],
  "comparables.net_adjustment": [
    "NetAdjustment",
    "NetAdjustmentAmount",
    "TotalNetAdjustment",
    "SalePriceTotalAdjustmentAmount",
    "NET_ADJUSTMENT"
  ],
  "comparables.net_adjustment_percent": ["SalesPriceTotalAdjustmentNetPercent", "NetAdjustmentPercent", "NET_ADJUSTMENT_PERCENT"],
  "comparables.gross_adjustment": ["GrossAdjustment", "GrossAdjustmentAmount", "TotalGrossAdjustment", "GROSS_ADJUSTMENT"],
  "comparables.gross_adjustment_percent": [
    "SalesPriceTotalAdjustmentGrossPercent",
    "GrossAdjustmentPercent",
    "GROSS_ADJUSTMENT_PERCENT"
  ],
  "comparables.adjusted_sale_price": [
    "AdjustedSalePrice",
    "AdjustedPrice",
    "IndicatedValue",
    "NetAdjustedSalePrice",
    "AdjustedSalesPriceAmount",
    "ADJUSTED_SALE_PRICE"
  ],
  "comparables.appraiser_comment": ["AppraiserComment", "Comment", "Comments", "ComparableComment", "COMMENT"],

  "adjustments.node": [
    "Adjustment",
    "AdjustmentLine",
    "GridAdjustment",
    "SALE_PRICE_ADJUSTMENT",
    "OTHER_FEATURE_ADJUSTMENT",
    "ROOM_ADJUSTMENT",
    "ADJUSTMENT"
  ],
  "adjustments.field": [
    "Field",
    "AdjustmentType",
    "LineItem",
    "Description",
    "_Type",
    "Type",
    "PropertyFeatureDescription",
    "_TypeOtherDescription",
    "FIELD"
  ],
  "adjustments.amount": [
    "Amount",
    "AdjustmentAmount",
    "Value",
    "_Amount",
    "PropertyFeatureAdjustmentAmount",
    "RoomAdjustmentAmount",
    "BathroomAdjustmentAmount",
    "AMOUNT"
  ],
  "adjustments.description": ["Description", "Comment", "Reason", "_Description", "PropertyFeatureDescription", "DESCRIPTION"],

  "reconciliation.indicated_value_low": ["IndicatedValueLow", "ValueRangeLow", "LowValue", "VALUE_RANGE_LOW"],
  "reconciliation.indicated_value_high": ["IndicatedValueHigh", "ValueRangeHigh", "HighValue", "VALUE_RANGE_HIGH"],
  "reconciliation.final_opinion_of_value": [
    "FinalOpinionOfValue",
    "AppraisedValue",
    "OpinionOfValue",
    "EstimatedValue",
    "FinalValue",
    "ReconciledValue",
    "PropertyAppraisedValueAmount",
    "FINAL_VALUE",
    "APPRAISED_VALUE",
    "OPINION_OF_VALUE"
  ],
  "reconciliation.sales_comparison_indicated_value": [
    "SalesComparisonIndicatedValue",
    "SalesComparisonValue",
    "SalesApproachValue",
    "ValueIndicatedBySalesComparisonApproachAmount",
    "SALES_COMPARISON_VALUE"
  ],
  "reconciliation.cost_approach_indicated_value": [
    "CostApproachIndicatedValue",
    "CostApproachValue",
    "ValueIndicatedByCostApproachAmount",
    "COST_APPROACH_VALUE"
  ],
  "reconciliation.income_approach_indicated_value": [
    "IncomeApproachIndicatedValue",
    "IncomeApproachValue",
    "ValueIndicatedByIncomeApproachAmount",
    "INCOME_APPROACH_VALUE"
  ],
  "reconciliation.narrative": [
    "Narrative",
    "ReconciliationNarrative",
    "FinalReconciliation",
    "ValueConclusionComment",
    "_SummaryComment",
    "_ConditionsComment",
    "RECONCILIATION_NARRATIVE"
  ],
  "reconciliation.confidence": ["Confidence", "Reliability", "ConfidenceLevel", "CONFIDENCE"],

  "appraiser_comments.subject_comments": ["SubjectComments", "SubjectComment", "PropertyComments"],
  "appraiser_comments.comp_comments": ["CompComments", "ComparableComments", "SalesComparisonComments"],
  "appraiser_comments.market_comments": ["MarketComments", "NeighborhoodComments"],
  "appraiser_comments.reconciliation_comments": ["ReconciliationComments", "FinalValueComments"],
  "appraiser_comments.extra_comments": ["ExtraComments", "AdditionalComments", "GeneralComments"]
} as const;

export type FieldAliasKey = keyof typeof FIELD_ALIASES;
export type GridRowAliasKey = keyof typeof GRID_ROW_ALIASES;

export function aliasesFor(field: FieldAliasKey): string[] {
  return [...FIELD_ALIASES[field]];
}

export function aliasTerminalNames(field: FieldAliasKey): string[] {
  return aliasesFor(field).map((alias) => alias.split(/[./]/).filter(Boolean).at(-1) ?? alias);
}

export function aliasPathParts(field: FieldAliasKey): string[][] {
  return aliasesFor(field)
    .map((alias) => alias.split(/[./]/).filter(Boolean))
    .filter((parts) => parts.length > 1);
}

export function gridAliasesFor(field: GridRowAliasKey): string[] {
  return [...GRID_ROW_ALIASES[field]];
}
