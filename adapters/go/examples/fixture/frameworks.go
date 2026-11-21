package fixture

import (
	"net/http"
	"regexp"

	"github.com/gin-gonic/gin"
	"github.com/go-chi/chi/v5"
	"github.com/labstack/echo/v4"

	chisendproof "github.com/mprync/sendproof/adapters/go/chi"
	echosendproof "github.com/mprync/sendproof/adapters/go/echo"
	ginsendproof "github.com/mprync/sendproof/adapters/go/gin"
	"github.com/mprync/sendproof/adapters/go/sendproof"
)

// bindNetHTTP routes everything through one http.ServeMux.
func bindNetHTTP(bench *sendproof.Sendproof, people *sessions, app *handlers, shared *http.ServeMux) http.Handler {
	for _, r := range app.allRoutes() {
		var handler http.Handler = r.handler(app)
		if r.preview {
			handler = bench.Operation(r.method, r.path).Wrap(handler)
		}
		shared.Handle(r.method+" "+r.path, people.require(r.role())(handler))
	}
	return shared
}

// bindChi routes the item operations with chi and falls back to the shared mux.
func bindChi(bench *sendproof.Sendproof, people *sessions, app *handlers, shared *http.ServeMux) http.Handler {
	router := chi.NewRouter()
	for _, r := range app.allRoutes() {
		handler := r.handler(app)
		bridge := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			for _, name := range pathParams(r.path) {
				req.SetPathValue(name, chi.URLParam(req, name))
			}
			handler(w, req)
		})
		middlewares := []func(http.Handler) http.Handler{people.require(r.role())}
		if r.preview {
			middlewares = append(middlewares, chisendproof.Preview(bench, r.method, r.path))
		}
		router.With(middlewares...).Method(r.method, r.path, bridge)
	}
	router.NotFound(shared.ServeHTTP)
	router.MethodNotAllowed(shared.ServeHTTP)
	return router
}

// templateParam matches one {name} parameter of an OpenAPI path template.
var templateParam = regexp.MustCompile(`\{([^}]+)\}`)

// colonPath converts {name} templates to Gin's and Echo's :name syntax.
func colonPath(path string) string { return templateParam.ReplaceAllString(path, ":$1") }

// pathParams lists the parameter names of a path template.
func pathParams(path string) []string {
	var names []string
	for _, match := range templateParam.FindAllStringSubmatch(path, -1) {
		names = append(names, match[1])
	}
	return names
}

// adaptMiddleware turns net/http middleware into a function that reports whether
// the request may continue, for routers with their own handler types.
func adaptMiddleware(mw func(http.Handler) http.Handler, w http.ResponseWriter, r *http.Request) bool {
	proceed := false
	mw(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { proceed = true })).ServeHTTP(w, r)
	return proceed
}

// bindGin routes the item operations with Gin and falls back to the shared mux.
func bindGin(bench *sendproof.Sendproof, people *sessions, app *handlers, shared *http.ServeMux) http.Handler {
	gin.SetMode(gin.ReleaseMode)
	engine := gin.New()
	for _, r := range app.allRoutes() {
		handler := r.handler(app)
		authorize := people.require(r.role())
		chain := []gin.HandlerFunc{func(c *gin.Context) {
			if !adaptMiddleware(authorize, c.Writer, c.Request) {
				c.Abort()
			}
		}}
		if r.preview {
			chain = append(chain, ginsendproof.Preview(bench, r.method, colonPath(r.path)))
		}
		chain = append(chain, func(c *gin.Context) {
			for _, name := range pathParams(r.path) {
				c.Request.SetPathValue(name, c.Param(name))
			}
			handler(c.Writer, c.Request)
		})
		engine.Handle(r.method, colonPath(r.path), chain...)
	}
	engine.NoRoute(gin.WrapH(shared))
	return engine
}

// bindEcho routes the item operations with Echo and falls back to the shared mux.
func bindEcho(bench *sendproof.Sendproof, people *sessions, app *handlers, shared *http.ServeMux) http.Handler {
	e := echo.New()
	e.HideBanner, e.HidePort = true, true
	for _, r := range app.allRoutes() {
		handler := r.handler(app)
		authorize := people.require(r.role())
		middlewares := []echo.MiddlewareFunc{func(next echo.HandlerFunc) echo.HandlerFunc {
			return func(c echo.Context) error {
				if !adaptMiddleware(authorize, c.Response(), c.Request()) {
					return nil
				}
				return next(c)
			}
		}}
		if r.preview {
			middlewares = append(middlewares, echosendproof.Preview(bench, r.method, colonPath(r.path)))
		}
		e.Add(r.method, colonPath(r.path), func(c echo.Context) error {
			for _, name := range pathParams(r.path) {
				c.Request().SetPathValue(name, c.Param(name))
			}
			handler(c.Response(), c.Request())
			return nil
		}, middlewares...)
	}
	e.Any("/*", echo.WrapHandler(shared))
	return e
}
