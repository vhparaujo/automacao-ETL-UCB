-- ============================================================
-- ARQUIVO DE EXEMPLO: como escrever queries de transformação
-- ============================================================
--
-- Este arquivo serve de modelo. Copie-o e adapte suas queries.
-- Adicione cada novo arquivo em config/transforms.json.
--
-- TIPOS DISPONÍVEIS em transforms.json:
--   "view"        → cria/atualiza uma VIEW (use CREATE OR REPLACE VIEW)
--   "exportar_csv"→ executa SELECT e salva CSV em exports/
--   "table"       → cria/recria tabela com resultado
--
-- ============================================================

-- EXEMPLO 1: Criar uma VIEW (tipo "view")
-- O PowerBI pode conectar diretamente nessa view.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW view_usuarios_ativos AS
SELECT
    u.UserId,
    u.UserName,
    u.FirstName,
    u.LastName,
    u.OrgDefinedId,
    u.ExternalEmail,
    u.SignupDate,
    u.LastAccessed
FROM users u
WHERE u.IsActive = 1;

-- ============================================================
-- EXEMPLO 2: SELECT para exportar CSV (tipo "exportar_csv")
-- Use apenas um SELECT — o resultado vira o CSV.
-- ------------------------------------------------------------
-- SELECT
--     u.UserId,
--     u.FirstName,
--     u.LastName,
--     e.OrgUnitId,
--     e.RoleName,
--     e.EnrollmentDate
-- FROM users u
-- JOIN userenrollments e ON u.UserId = e.UserId
-- WHERE u.IsActive = 1
-- ORDER BY e.OrgUnitId, u.LastName;
