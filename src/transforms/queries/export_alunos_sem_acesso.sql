-- ============================================================================
-- export_alunos_sem_acesso
-- Objetivo: alunos (RoleId 110) ativos, matriculados em ofertas de curso do
--           semestre 2026/2, que NUNCA acessaram nenhuma disciplina no AVA
--           (sem nenhum registro em courseaccess, histórico desde 2021).
-- Tabelas: organizationalunits, userenrollments, users, courseaccess
-- Dados pessoais: SIM — lista nominal para contato da coordenação.
-- Desempenho: as tabelas têm índices (schemas.json → "indices") e estatísticas
--             atualizadas (ANALYZE TABLE após cada carga) — roda em ~2 s.
--             O STRAIGHT_JOIN não é mais necessário; foi mantido só por
--             fixar a ordem dos joins (não atrapalha).
-- ============================================================================
SELECT
  u.UserId                                              AS user_id,
  u.OrgDefinedId                                        AS matricula,
  u.FirstName                                           AS nome,
  u.LastName                                            AS sobrenome,
  u.ExternalEmail                                       AS email,
  COUNT(*)                                              AS disciplinas_matriculadas,
  GROUP_CONCAT(m.Code ORDER BY m.Code SEPARATOR ' | ')  AS disciplinas,
  MIN(m.EnrollmentDate)                                 AS primeira_matricula
FROM (
  -- uma linha por (aluno, disciplina do semestre)
  SELECT ue.UserId, ou.Code, MIN(ue.EnrollmentDate) AS EnrollmentDate
  FROM organizationalunits ou
  STRAIGHT_JOIN userenrollments ue
    ON ue.OrgUnitId = ou.OrgUnitId
   AND ue.RoleId = 110                                  -- Aluno
  WHERE ou.Type = 'Course Offering'
    AND ou.IsDeleted = 0
    AND ou.StartDate >= '2026-07-01'                    -- semestre 2026/2
  GROUP BY ue.UserId, ou.OrgUnitId, ou.Code
) m
STRAIGHT_JOIN users u
  ON u.UserId = m.UserId
 AND u.IsActive = 1
LEFT JOIN (SELECT DISTINCT UserId FROM courseaccess) ca
  ON ca.UserId = m.UserId
LEFT JOIN (SELECT DISTINCT UserId FROM courseaccesslog) cal
  ON cal.UserId = m.UserId
WHERE ca.UserId IS NULL
  AND cal.UserId IS NULL          -- também nunca acessou pelo app (Pulse)                            -- nunca acessou
GROUP BY u.UserId, u.OrgDefinedId, u.FirstName, u.LastName, u.ExternalEmail
ORDER BY sobrenome, nome;
