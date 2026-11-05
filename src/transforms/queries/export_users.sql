SELECT
  UserId,
  UserName,
  OrgDefinedId,
  FirstName,
  MiddleName,
  LastName,
  IsActive,
  ExternalEmail,
  CreationDate,
  OrgRoleId,
  DateDeleted
FROM users
ORDER BY LastName, FirstName;
