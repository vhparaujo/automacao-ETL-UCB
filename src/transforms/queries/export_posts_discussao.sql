SELECT
  OrgUnitId,
  TopicId,
  UserId,
  PostId,
  ThreadId,
  IsReply,
  ParentPostId,
  NumReplies,
  DatePosted,
  IsDeleted,
  RatingSum,
  NumRatings,
  Score,
  LastEditDate,
  SortOrder,
  Depth,
  WordCount,
  AttachmentCount
FROM discussionposts
ORDER BY OrgUnitId, ThreadId, DatePosted;
