SELECT
  `Nome de usuário`,
  `Nome`,
  `Sobrenome`,
  `ID definido da organização`,
  `ID do Usuário`,
  `Nome da função`,
  `ID da função`,
  `Ativo`,
  `Nome da oferta de curso`,
  `Código da oferta de curso`,
  `ID da oferta de curso`,
  `Nota Final Calculada`,
  `Nota Final Ajustada`,
  `Esquema de nota - Símbolo`,
  `Nota Liberada`,
  `Data de Liberação da Nota`,
  `Última Modificação da Nota`,
  `Comentários de nota final`
FROM notas_finais
ORDER BY `Nome da oferta de curso`, `Sobrenome`, `Nome`;
