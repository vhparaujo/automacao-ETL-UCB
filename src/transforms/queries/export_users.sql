SELECT
  UserId,
  UserName,
  OrgDefinedId,
  FirstName,
  MiddleName,
  LastName,
  IsActive,
  Organization,
  ExternalEmail,
  SignupDate,
  FirstLoginDate,
  OrgRoleId,
  LastAccessed
FROM users
ORDER BY LastName, FirstName;
