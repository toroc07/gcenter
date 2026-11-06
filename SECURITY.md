# Seguridad

## Dónde viven tus credenciales

GCenter **nunca** guarda API keys dentro del proyecto. Las llaves de los
agentes que añades se escriben en tu perfil de usuario, fuera de cualquier
repositorio:

| Sistema | Ruta |
|---|---|
| Windows | `%APPDATA%\GCenter\config.json` |
| Linux | `~/.config/gcenter/config.json` |
| macOS | `~/Library/Application Support/GCenter/config.json` |

La interfaz solo ve una versión enmascarada de cada llave, y cada llave solo
se envía al proveedor al que pertenece.

GCenter **no gestiona** las credenciales del orquestador: Claude Code y OpenCode
usan la sesión que hayas iniciado en ellos, con su propio almacenamiento.
GCenter tampoco modifica su configuración: lo que necesita (su servidor MCP y
el prompt de orquestador) se les pasa solo al arrancar.

## Qué puede hacer la aplicación en tu equipo

- **Escrituras confinadas.** Los agentes solo pueden escribir dentro del
  directorio de trabajo elegido; cualquier ruta que intente salir de él se
  rechaza. Si un archivo ya existía, se guarda una copia en la carpeta
  `backups` de la configuración antes de sobrescribirlo.
- **Respeto a los modos supervisados.** En los modos *Plan*, *Manual* y
  *No preguntar* de Claude Code, y en *Plan* de OpenCode, GCenter no escribe
  archivos por su cuenta: devuelve el contenido y decide el orquestador.
- **Telemetría local.** El canal entre el servidor MCP y la interfaz escucha
  solo en `127.0.0.1` y exige un token aleatorio que se regenera en cada
  arranque.
- **Sin cargos, mientras el filtro esté activado.** El filtro de gratuidad
  rechaza cualquier modelo de pago, o cuya gratuidad no se pueda comprobar,
  antes de llamar al proveedor (ver el README). Si lo desactivas, los modelos de
  pago de tus agentes pueden generar cargos en tus cuentas.

## Lo que conviene saber de los proveedores gratuitos

Varios proveedores declaran que **pueden usar los prompts del tier gratuito
para entrenar o mejorar sus modelos**. No delegues código ni datos que no
quieras compartir con terceros.

## Informar de una vulnerabilidad

No abras un issue público. Usa la opción
[**Report a vulnerability**](https://github.com/toroc07/gcenter/security/advisories/new)
de la pestaña *Security* del repositorio, que crea un aviso privado.
