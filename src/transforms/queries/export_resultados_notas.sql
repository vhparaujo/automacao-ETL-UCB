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
  IsDeleted,
  LastModified,
  LastModifiedBy,
  Comments,
  PrivateComments,
  GradeText,
  GradeReleasedDate
FROM graderesults
ORDER BY OrgUnitId, GradeObjectId, UserId;
