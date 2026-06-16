SELECT
  OrgUnitId,
  UserId,
  DayAccessed
FROM courseaccess
ORDER BY OrgUnitId, UserId, DayAccessed;
