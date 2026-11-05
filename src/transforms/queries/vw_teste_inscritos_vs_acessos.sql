-- ============================================================================
-- vw_teste_inscritos_vs_acessos — VIEW DE TESTE
-- ----------------------------------------------------------------------------
-- Objetivo: validar a cadeia download → carga → transformação → PowerBI.
-- NÃO é uma view de dashboard: não filtra por role (alunos, professores e
-- demais papéis contam juntos) nem por tipo de unidade organizacional
-- (aparecem cursos, ofertas, departamentos etc. que tiverem inscrições).
--
-- Por unidade organizacional ("disciplina"), conta:
--   inscritos      — usuários distintos em userenrollments
--   com_acesso     — desses inscritos, quantos têm ao menos um dia em courseaccess
--   sem_acesso     — inscritos − com_acesso
--   pct_com_acesso — % de inscritos com acesso (0–100, 2 casas)
--
-- Dados agregados: não expõe nenhum dado pessoal.
-- Tabelas/colunas usadas (todas em config/schemas.json):
--   userenrollments(OrgUnitId, UserId, RoleId)
--   courseaccess(OrgUnitId, UserId, DayAccessed)
--   organizationalunits(OrgUnitId, Name, Code, Type)
-- ============================================================================
CREATE OR REPLACE VIEW vw_teste_inscritos_vs_acessos AS
SELECT
  ou.OrgUnitId                                                       AS org_unit_id,
  ou.Name                                                            AS disciplina,
  ou.Code                                                            AS codigo,
  ou.Type                                                            AS tipo,
  COUNT(DISTINCT ue.UserId)                                          AS inscritos,
  COUNT(DISTINCT ca.UserId)                                          AS com_acesso,
  COUNT(DISTINCT ue.UserId) - COUNT(DISTINCT ca.UserId)              AS sem_acesso,
  ROUND(100 * COUNT(DISTINCT ca.UserId) / NULLIF(COUNT(DISTINCT ue.UserId), 0), 2) AS pct_com_acesso
FROM organizationalunits ou
JOIN userenrollments ue
  ON ue.OrgUnitId = ou.OrgUnitId
LEFT JOIN (
  -- um registro por (unidade, usuário) com pelo menos um dia de acesso
  SELECT DISTINCT OrgUnitId, UserId
  FROM courseaccess
  WHERE DayAccessed IS NOT NULL
) ca
  ON ca.OrgUnitId = ue.OrgUnitId
 AND ca.UserId    = ue.UserId
GROUP BY ou.OrgUnitId, ou.Name, ou.Code, ou.Type;
