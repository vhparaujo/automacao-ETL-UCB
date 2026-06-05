-- querys importantes pra subir os datasets 
  
-- SET GLOBAL local_infile = true;
  -- set global local_infile = 1;
-- SHOW VARIABLES LIKE 'secure_file_priv';
  -- SHOW GLOBAL VARIABLES LIKE 'local_infile';

-- LOAD DATA PARA SUBIR A TABELA DE USUARIOS 
LOAD DATA INFILE
'C:/ProgramData/MySQL/MySQL Server 8.0/Uploads/Users.csv'
-- 'C:/Uploads/Users.csv'
INTO TABLE datasetava.users
FIELDS TERMINATED BY ',' 
ENCLOSED BY '"'
LINES TERMINATED BY '\n'
IGNORE 1 ROWS
(UserId,UserName,OrgDefinedId,
FirstName,MiddleName,LastName,
IsActive,Organization,ExternalEmail,SignupDate,
FirstLoginDate,Version,OrgRoleId,
LastAccessed) ;

-- LOAD DATA UNIDADES ORGANIZACIONAIS 

/*LOAD DATA INFILE
'C:/ProgramData/MySQL/MySQL Server 8.0/Uploads/OrganizationalUnits.csv'
INTO TABLE datasetava.organizationalunits
FIELDS TERMINATED BY ',' 
ENCLOSED BY '"'
LINES TERMINATED BY '\n'
IGNORE 1 ROWS
(OrgUnitId,Organization, Type, Name, Code, StartDate, EndDate, IsActive, CreatedDate, IsDeleted, DeletedDate, RecycledDate, Version, OrgUnitTypeId);*/

-- LOAD DATA PRA OBJETOS DE CONTEUDO (ERRADO)
/*LOAD DATA INFILE
'C:/ProgramData/MySQL/MySQL Server 8.0/Uploads/ContentObjects.csv'
INTO TABLE datasetava.contentobjects
FIELDS TERMINATED BY ',' 
ENCLOSED BY '"'
LINES TERMINATED BY '\n'
IGNORE 1 ROWS
(ContentObjectId , 
OrgUnitId , 
Title , 
ContentObjectType , 
CompletionType , 
ParentContentObjectId , 
Location , 
StartDate , 
EndDate , 
DueDate , 
ObjectId1 , 
ObjectId2 , 
ObjectId3 , 
LastModified , 
IsDeleted , 
SortOrder , 
Depth , 
ToolId , 
IsHidden , 
ResultId , 
DeletedDate , 
CreatedBy , 
LastModifiedBy , 
DeletedBy );*/

-- LOAD DATA OBJETOS DE CONTEÚDO + ROBUSTO (CORRETO)
/*LOAD DATA INFILE
'C:/ProgramData/MySQL/MySQL Server 8.0/Uploads/ContentObjects.csv'
INTO TABLE datasetava.contentobjects
FIELDS TERMINATED BY ',' 
OPTIONALLY ENCLOSED BY '"'
ESCAPED BY '"'
LINES TERMINATED BY '\n'
IGNORE 1 ROWS
(
@ContentObjectId , 
@OrgUnitId , 
@Title , 
@ContentObjectType , 
@CompletionType , 
@ParentContentObjectId , 
@Location , 
@StartDate , 
@EndDate , 
@DueDate , 
@ObjectId1 , 
@ObjectId2 , 
@ObjectId3 , 
@LastModified , 
@IsDeleted , 
@SortOrder , 
@Depth , 
@ToolId , 
@IsHidden , 
@ResultId , 
@DeletedDate , 
@CreatedBy , 
@LastModifiedBy , 
@DeletedBy,
@AIUtilization
)

SET
ContentObjectId = NULLIF(@ContentObjectId,''),
OrgUnitId = NULLIF(@OrgUnitId,''),
Title = NULLIF(@Title,''),
ContentObjectType = NULLIF(@ContentObjectType,''),
CompletionType = NULLIF(@CompletionType,''),
ParentContentObjectId = NULLIF(@ParentContentObjectId,''),
Location = NULLIF(@Location,''),

StartDate = NULLIF(@StartDate,''),
EndDate = NULLIF(@EndDate,''),
DueDate = NULLIF(@DueDate,''),

ObjectId1 = NULLIF(@ObjectId1,''),
ObjectId2 = NULLIF(@ObjectId2,''),
ObjectId3 = NULLIF(@ObjectId3,''),

LastModified = NULLIF(@LastModified,''),
IsDeleted = NULLIF(@IsDeleted,''),

SortOrder = NULLIF(@SortOrder,''),
Depth = NULLIF(@Depth,''),
ToolId = NULLIF(@ToolId,''),
IsHidden = NULLIF(@IsHidden,''),
ResultId = NULLIF(@ResultId,''),

DeletedDate = NULLIF(@DeletedDate,''),

CreatedBy = NULLIF(@CreatedBy,''),
LastModifiedBy = NULLIF(@LastModifiedBy,''),
DeletedBy = NULLIF(@DeletedBy,''); */


-- OUTRO LOAD DATA PARA USO DO PROFESSOR

/*LOAD DATA INFILE 'C:/ProgramData/MySQL/MySQL Server 8.0/Uploads/usoprofessor.csv'
INTO TABLE usoprofessor
FIELDS TERMINATED BY ',' 
ENCLOSED BY '"'
LINES TERMINATED BY '\n'
IGNORE 1 ROWS
(Nomedeusuario,
 Nome,
 Sobrenome,
 IDDefinidodaOrganizacao,
 IddoUsuario,
 NomedaFuncao,
 IddaFuncao,
 Ativo, 
 NomedaOfertadeCurso,
 CodigodaOfertadeCurso,
 IddeOfertadeCurso,
 NumerodeTopicosdeConteudoVisitados, 
 UltimoAcessoaoConteudodaOfertadeCurso,
 NumerodeAtribuicoes,
 NumerodeEnviosdeAtividadescomComentarios, 
 NumerodeNotas,
 NumerodeNotascomAvaliacoes,
 UltimaModificacaodeumaNota,
 NumerodePostagensdeDiscussao, 
 NumerodePostagensdeDiscussaoCriadas,
 UltimaDatadePostagemdeDiscussao,
 UltimoAcessoaOfertadeCurso, 
 NumerodeLogonsaoSistema,
 DatadoUltimoe_mailEnviado)
SET IddaFuncao = NULLIF(IddaFuncao, '');*/

-- LOAD DATA DO LOG DE ACESSO AO SISTEMA

/*LOAD DATA LOCAL INFILE 'C:\ProgramData\MySQL\MySQL Server 8.0\Uploads\SystemAccessLog.csv'
INTO TABLE datasetava.systemaccesslog
FIELDS TERMINATED BY ',' 
ENCLOSED BY '"'
LINES TERMINATED BY '\n'
IGNORE 1 ROWS
(SessionId ,
UserId , 
Timestamp ,
State , 
Source , 
AppVersion , 
Device , 
IsOfflineMode , 
IPAddress);*/

-- LOAD DATA DO TODAS AS NOTAS

/*LOAD DATA INFILE 'C:/ProgramData/MySQL/MySQL Server 8.0/Uploads/todasnotas.csv'
INTO TABLE datasetava.todasnotas
FIELDS TERMINATED BY ',' 
ENCLOSED BY '"'
LINES TERMINATED BY '\n'
IGNORE 1 ROWS
(UserID,
UserName1,
username,
FirstName,
LastName,
Active,
IdFuncao,
NameFuncao,
IdOferta,
CodOferta,
NameOferta,
IDSessCurso,
CodSessCurso,
NameSessCurso,
IdCatNota,
NameCatNota,
IdNota,
NameNota,
@PesoNota,
DataInNota,
DataFinNota,
@PontosObtidos,
@PontoVale,
@ValorNota,
ModificaNota,
ComentNota,
IdUsuarioGrad,
IdOrgDefGrad,
NameGraduando,
NameGraduando2,
LastNameNota,
ExclNotaFinal,
TipoObjetoNota)
SET 
PesoNota = NULLIF(REPLACE(@PesoNota, ',', '.'), ''),
PontosObtidos = NULLIF(REPLACE(@PontosObtidos, ',', '.'), ''),
PontoVale = NULLIF(REPLACE(@PontoVale, ',', '.'), ''),
ValorNota = NULLIF(REPLACE(@ValorNota, ',', '.'), '');*/

-- LOAD DATA OBJETOS DE NOTA 

/*LOAD DATA INFILE 'C:/ProgramData/MySQL/MySQL Server 8.0/Uploads/GradeObjects.csv'
INTO TABLE gradeobjects
FIELDS TERMINATED BY ',' 
ENCLOSED BY '"' 
LINES TERMINATED BY '\n'
IGNORE 1 ROWS
(
    GradeObjectId,
    OrgUnitId,
    ParentGradeObjectId,
    Name,
    TypeName,
    StartDate,
    EndDate,
    IsAutoPointed,
    IsFormula,
    IsBonus,
    MaxPoints,
    CanExceedMaxGrade,
    ExcludeFromFinalGradeCalc,
    GradeSchemeId,
    Weight,
    NumLowestGradesToDrop,
    NumHighestGradesToDrop,
    WeightDistributionType,
    CreatedDate,
    ToolName,
    AssociatedToolItemId,
    LastModified,
    ShortName,
    GradeObjectTypeId,
    SortOrder,
    IsDeleted,
    DeletedDate,
    DeletedByUserId,
    ResultId,
    @ToolId_dummy, -- essa parte aqui do comando ignora as duas colunas que tem a mais no csv que nao tem aqui
    @Version_dummy
)*/

-- LOAD DATA DO RESULTADO DE NOTAS (algumas linhas deram erro, mas ignora na consulta)

/*LOAD DATA LOCAL INFILE 'C:/ProgramData/MySQL/MySQL Server 8.0/Uploads/GradeResults.csv'
INTO TABLE datasetava.graderesults
FIELDS TERMINATED BY ','
ENCLOSED BY '"'
LINES TERMINATED BY '\n'
IGNORE 1 ROWS
(
  GradeObjectId,
  OrgUnitId,
  UserId,
  PointsNumerator,
  PointsDenominator,
  WeightedNumerator,
  WeightedDenominator,
  IsReleased,
  IsDropped,
  LastModified,
  LastModifiedBy,
  Comments,
  PrivateComments,
  GradeText,
  GradeReleasedDate,
  Version,
  @IsDeleted
)
SET IsExempt = '';*/


-- LOAD DATA PARA O USO DO ALUNO

/*LOAD DATA INFILE 
'C:/ProgramData/MySQL/MySQL Server 8.0/Uploads/UsodoAluno.csv'
INTO TABLE datasetava.usodoaluno
FIELDS TERMINATED BY ',' 
ENCLOSED BY '"'
LINES TERMINATED BY '\n'
IGNORE 1 ROWS
(
  `Id de Oferta de Curso`,
  `Código da Oferta de Curso`,
  `Nome da Oferta de Curso`,
  `Nome do Departamentos Principal`,
  `Código do Departamentos Principal`,
  `Id do Semestre`,
  `Código do Semestre`,
  `Nome do Semestre`,
  `Id do Usuário`,
  `Nome de usuário`,
  `ID Definido da Organização`,
  `Nome`,
  `Sobrenome`,
  `Ativo`,
  `Id da Função`,
  `Nome da Função`,
  `Conteúdo Concluído`,
  `Conteúdo Necessário`,
  `Lista de Verificação Concluída`,
  `Questionário Concluído`,
  `Total de Tentativas de Realização do Questionário`,
  `Postagem de Discussão Criada`,
  `Respostas à Postagem de Discussão`,
  `Postagem de Discussão Lida`,
  `Última Data de Postagem de Discussão`,
  `Número de Envios de Atribuições`,
  `Última Data de Envio da Atribuição`,
  `Total de Tempo Gasto no Conteúdo`,
  `Data da Última Visita`,
  `Último Logon do Sistema`,
  `Número de Logons ao Sistema`,
  `Nome do Auditor`,
  `Data da última tentativa de realização do teste`,
  @conclusao_scorm,
  @visita_scorm
)
SET
  `Conclusao SCORM` = NULLIF(@conclusao_scorm, ''),
  `Ultima Visita SCORM` = NULLIF(@visita_scorm, '');*/
  
  -- LOAD DATA PARA A TABELA USER ENROLLMENTS
 
 /*LOAD DATA INFILE
'C:/ProgramData/MySQL/MySQL Server 8.0/Uploads/UserEnrollments.csv'
INTO TABLE datasetava.userenrollments
FIELDS TERMINATED BY ',' 
ENCLOSED BY '"'
LINES TERMINATED BY '\n'
IGNORE 1 ROWS
(OrgUnitId, UserId, RoleName, EnrollmentDate, EnrollmentType, RoleId);*/


-- LOAD DATA PARA LOG DE ACESSO AO CURSO
 
/*LOAD DATA INFILE
'C:/ProgramData/MySQL/MySQL Server 8.0/Uploads/CourseAccessLog.csv'
INTO TABLE datasetava.courseaccesslog
FIELDS TERMINATED BY ',' 
ENCLOSED BY '"'
LINES TERMINATED BY '\n'
IGNORE 1 ROWS
(OrgUnitId, UserId, Timestamp, Source);*/

-- LOAD DATA PARA COURSE ACCESS

/*LOAD DATA LOCAL INFILE
'C:/ProgramData/MySQL/MySQL Server 8.0/Uploads/CourseAccess.csv'
INTO TABLE datasetava.courseaccess
FIELDS TERMINATED BY ',' 
ENCLOSED BY '"'
LINES TERMINATED BY '\n'
IGNORE 1 ROWS
(OrgUnitId, UserId, DayAccessed);*/

-- LOAD DATA POSTS DE DISCUSSÃO

/*LOAD DATA LOCAL INFILE 'C:/ProgramData/MySQL/MySQL Server 8.0/Uploads/postsdediscussao.csv'
INTO TABLE datasetava.postsdediscussao
CHARACTER SET utf8mb4
FIELDS TERMINATED BY ',' 
ENCLOSED BY '"'
LINES TERMINATED BY '\r\n'
IGNORE 1 ROWS
(@OrgUnitId, @TopicId, @UserId, @PostId, @ThreadId, @IsReply, @ParentPostId, @NumReplies, @DatePosted, @IsDeleted, @RatingSum, @NumRatings, @Score, @LastEditDate, @SortOrder, @Depth, @Thread, @WordCount, @AttachmentCount, @Version)
SET
  OrgUnitId = NULLIF(@OrgUnitId,''),
  TopicId = NULLIF(@TopicId,''),
  UserId = NULLIF(@UserId,''),
  PostId = NULLIF(@PostId,''),
  ThreadId = NULLIF(@ThreadId,''),
  IsReply = IF(LOWER(@IsReply) IN ('1','true','t','y','yes'),1,0),
  ParentPostId = NULLIF(@ParentPostId,''),
  NumReplies = NULLIF(@NumReplies,''),
  DatePosted = NULLIF(@DatePosted,''),
  IsDeleted = IF(LOWER(@IsDeleted) IN ('1','true','t','y','yes'),1,0),
  RatingSum = NULLIF(@RatingSum,''),
  NumRatings = NULLIF(@NumRatings,''),
  Score = NULLIF(@Score,''),
  LastEditDate = NULLIF(@LastEditDate,''),
  SortOrder = NULLIF(@SortOrder,''),
  Depth = NULLIF(@Depth,''),
  Thread = NULLIF(@Thread,''),
  WordCount = NULLIF(@WordCount,''),
  AttachmentCount = NULLIF(@AttachmentCount,''),
  Version = NULLIF(@Version,'');*/


