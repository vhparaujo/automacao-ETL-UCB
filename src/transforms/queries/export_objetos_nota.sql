SELECT
  GradeObjectId,
  OrgUnitId,
  ParentGradeObjectId,
  Name,
  TypeName,
  StartDate,
  EndDate,
  IsBonus,
  MaxPoints,
  Weight,
  ExcludeFromFinalGradeCalc,
  CreatedDate,
  LastModified,
  IsDeleted
FROM gradeobjects
ORDER BY OrgUnitId, SortOrder;
