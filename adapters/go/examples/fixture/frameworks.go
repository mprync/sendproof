package fixture

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/go-chi/chi/v5"
	"github.com/labstack/echo/v4"

	chibench "github.com/test-bench/test-bench/adapters/go/chi"
	echobench "github.com/test-bench/test-bench/adapters/go/echo"
	ginbench "github.com/test-bench/test-bench/adapters/go/gin"
	"github.com/test-bench/test-bench/adapters/go/testbench"
)

// bindNetHTTP routes everything through one http.ServeMux.
func bindNetHTTP(bench *testbench.Bench, people *sessions, app *handlers, shared *http.ServeMux) http.Handler {
	for _, r := range routes {
		var handler http.Handler = r.handler(app)
		if r.preview {
			handler = bench.Operation(r.method, r.path).Wrap(handler)
		}
		shared.Handle(r.method+" "+r.path, people.require(r.role())(handler))
	}
	return shared
}

// bindChi routes the item operations with chi and falls back to the shared mux.
func bindChi(bench *testbench.Bench, people *sessions, app *handlers, shared *http.ServeMux) http.Handler {
	router := chi.NewRouter()
	for _, r := range routes {
		handler := r.handler(app)
		bridge := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			req.SetPathValue("id", chi.URLParam(req, "id"))
			handler(w, req)
		})
		middlewares := []func(http.Handler) http.Handler{people.require(r.role())}
		if r.preview {
			middlewares = append(middlewares, chibench.Preview(bench, r.method, r.path))
		}
		router.With(middlewares...).Method(r.method, r.path, bridge)
	}
	router.NotFound(shared.ServeHTTP)
	router.MethodNotAllowed(shared.ServeHTTP)
	return router
}

// ginPath and echoPath convert {id} templates to each framework's syntax.
func colonPath(path string) string { return strings.ReplaceAll(path, "{id}", ":id") }

// adaptMiddleware turns net/http middleware into a function that reports whether
// the request may continue, for routers with their own handler types.
func adaptMiddleware(mw func(http.Handler) http.Handler, w http.ResponseWriter, r *http.Request) bool {
	proceed := false
	mw(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { proceed = true })).ServeHTTP(w, r)
	return proceed
}

// bindGin routes the item operations with Gin and falls back to the shared mux.
func bindGin(bench *testbench.Bench, people *sessions, app *handlers, shared *http.ServeMux) http.Handler {
	gin.SetMode(gin.ReleaseMode)
	engine := gin.New()
	for _, r := range routes {
		handler := r.handler(app)
		authorize := people.require(r.role())
		chain := []gin.HandlerFunc{func(c *gin.Context) {
			if !adaptMiddleware(authorize, c.Writer, c.Request) {
				c.Abort()
			}
		}}
		if r.preview {
			chain = append(chain, ginbench.Preview(bench, r.method, colonPath(r.path)))
		}
		chain = append(chain, func(c *gin.Context) {
			c.Request.SetPathValue("id", c.Param("id"))
			handler(c.Writer, c.Request)
		})
		engine.Handle(r.method, colonPath(r.path), chain...)
	}
	engine.NoRoute(gin.WrapH(shared))
	return engine
}

// bindEcho routes the item operations with Echo and falls back to the shared mux.
func bindEcho(bench *testbench.Bench, people *sessions, app *handlers, shared *http.ServeMux) http.Handler {
	e := echo.New()
	e.HideBanner, e.HidePort = true, true
	for _, r := range routes {
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
			middlewares = append(middlewares, echobench.Preview(bench, r.method, colonPath(r.path)))
		}
		e.Add(r.method, colonPath(r.path), func(c echo.Context) error {
			c.Request().SetPathValue("id", c.Param("id"))
			handler(c.Response(), c.Request())
			return nil
		}, middlewares...)
	}
	e.Any("/*", echo.WrapHandler(shared))
	return e
}
