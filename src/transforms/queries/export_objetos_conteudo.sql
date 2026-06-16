SELECT
  ContentObjectId,
  OrgUnitId,
  ParentContentObjectId,
  Title,
  ContentObjectType,
  CompletionType,
  Location,
  StartDate,
  EndDate,
  DueDate,
  LastModified,
  IsDeleted,
  SortOrder,
  Depth,
  IsHidden,
  ToolId,
  ResultId,
  DeletedDate,
  CreatedBy,
  LastModifiedBy,
  DeletedBy
FROM contentobjects
ORDER BY OrgUnitId, SortOrder, Depth;
