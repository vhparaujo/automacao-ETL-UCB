SELECT
  OrgUnitId,
  UserId,
  RoleName,
  RoleId,
  EnrollmentDate,
  EnrollmentType
FROM userenrollments
ORDER BY OrgUnitId, UserId;
