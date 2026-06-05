SELECT
  OrgUnitId,
  Organization,
  Type,
  Name,
  Code,
  StartDate,
  EndDate,
  IsActive,
  CreatedDate,
  IsDeleted,
  OrgUnitTypeId
FROM organizationalunits
ORDER BY Type, Name;
