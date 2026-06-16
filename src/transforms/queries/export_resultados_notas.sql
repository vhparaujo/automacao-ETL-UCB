SELECT
  GradeObjectId,
  OrgUnitId,
  UserId,
  PointsNumerator,
  PointsDenominator,
  WeightedNumerator,
  WeightedDenominator,
  IsReleased,
  IsDropped,
  IsExempt,
  LastModified,
  LastModifiedBy,
  Comments,
  PrivateComments,
  GradeText,
  GradeReleasedDate
FROM graderesults
ORDER BY OrgUnitId, GradeObjectId, UserId;
