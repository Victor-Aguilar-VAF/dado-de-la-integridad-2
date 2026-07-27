(function exposeSolidDiceRenderer(global) {
  "use strict";

  const DEG_TO_RAD = Math.PI / 180;
  const STANDARD_TEXTURE_SIZE = 1024;
  const HIGH_RES_TEXTURE_SIZE = 2048;
  const OUTPUT_SUPERSAMPLING = 1.3;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) || "No se pudo compilar el shader del dado.";
      gl.deleteShader(shader);
      throw new Error(message);
    }

    return shader;
  }

  function createProgram(gl, vertexSource, fragmentSource) {
    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program) || "No se pudo enlazar el renderizador del dado.";
      gl.deleteProgram(program);
      throw new Error(message);
    }

    return program;
  }

  function perspectiveMatrix(fieldOfView, aspect, near, far) {
    const f = 1 / Math.tan(fieldOfView / 2);
    const range = 1 / (near - far);

    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * range, -1,
      0, 0, (2 * far * near) * range, 0
    ]);
  }

  function pushVertex(target, position, normal, uv) {
    target.push(
      position[0], position[1], position[2],
      normal[0], normal[1], normal[2],
      uv[0], uv[1]
    );
  }

  function roundedCubePoint(point, radius) {
    const inner = 1 - radius;
    const nearest = [
      clamp(point[0], -inner, inner),
      clamp(point[1], -inner, inner),
      clamp(point[2], -inner, inner)
    ];
    const delta = [
      point[0] - nearest[0],
      point[1] - nearest[1],
      point[2] - nearest[2]
    ];
    const length = Math.hypot(delta[0], delta[1], delta[2]) || 1;
    const normal = [delta[0] / length, delta[1] / length, delta[2] / length];

    return {
      position: [
        nearest[0] + normal[0] * radius,
        nearest[1] + normal[1] * radius,
        nearest[2] + normal[2] * radius
      ],
      normal
    };
  }

  function createRoundedCubeVertices(segments = 32, radius = 0.16) {
    const vertices = [];
    const faces = [
      (u, v) => [u, v, 1],
      (u, v) => [1, v, -u],
      (u, v) => [-u, v, -1],
      (u, v) => [-1, v, u],
      (u, v) => [u, 1, -v],
      (u, v) => [u, -1, v]
    ];

    faces.forEach(mapPoint => {
      for (let row = 0; row < segments; row += 1) {
        const v0 = -1 + (row / segments) * 2;
        const v1 = -1 + ((row + 1) / segments) * 2;

        for (let column = 0; column < segments; column += 1) {
          const u0 = -1 + (column / segments) * 2;
          const u1 = -1 + ((column + 1) / segments) * 2;
          const corners = [
            roundedCubePoint(mapPoint(u0, v0), radius),
            roundedCubePoint(mapPoint(u1, v0), radius),
            roundedCubePoint(mapPoint(u1, v1), radius),
            roundedCubePoint(mapPoint(u0, v1), radius)
          ];

          [0, 1, 2, 0, 2, 3].forEach(index => {
            pushVertex(vertices, corners[index].position, corners[index].normal, [0, 0]);
          });
        }
      }
    });

    return new Float32Array(vertices);
  }

  function combineVectors(a, b, c, bScale = 1, cScale = 1) {
    return [
      a[0] + b[0] * bScale + c[0] * cScale,
      a[1] + b[1] * bScale + c[1] * cScale,
      a[2] + b[2] * bScale + c[2] * cScale
    ];
  }

  function roundedRectangleOutline(halfSize, radius, segmentsPerCorner = 12) {
    const outline = [];
    const cornerDistance = halfSize - radius;
    const corners = [
      [cornerDistance, cornerDistance, 0],
      [-cornerDistance, cornerDistance, 90],
      [-cornerDistance, -cornerDistance, 180],
      [cornerDistance, -cornerDistance, 270]
    ];

    corners.forEach(([centerX, centerY, startAngle]) => {
      for (let step = 0; step < segmentsPerCorner; step += 1) {
        const angle = (startAngle + (step / segmentsPerCorner) * 90) * DEG_TO_RAD;
        outline.push([
          centerX + Math.cos(angle) * radius,
          centerY + Math.sin(angle) * radius
        ]);
      }
    });

    return outline;
  }

  function createRoundedSurfaceVertices(center, right, up, normal, halfSize, radius) {
    const outline = roundedRectangleOutline(halfSize, radius);
    const vertices = [];
    const centerUv = [0.5, 0.5];

    for (let index = 0; index < outline.length; index += 1) {
      const current = outline[index];
      const next = outline[(index + 1) % outline.length];
      const currentPosition = combineVectors(center, right, up, current[0], current[1]);
      const nextPosition = combineVectors(center, right, up, next[0], next[1]);
      const currentUv = [
        0.5 + current[0] / (halfSize * 2),
        0.5 + current[1] / (halfSize * 2)
      ];
      const nextUv = [
        0.5 + next[0] / (halfSize * 2),
        0.5 + next[1] / (halfSize * 2)
      ];

      pushVertex(vertices, center, normal, centerUv);
      pushVertex(vertices, currentPosition, normal, currentUv);
      pushVertex(vertices, nextPosition, normal, nextUv);
    }

    return vertices;
  }

  function createPlateVertices(definition, {
    innerOffset = 1.004,
    outerOffset = 1.03,
    halfSize = 0.875,
    radius = 0.105
  } = {}) {
    const [, right, up, normal] = definition;
    const innerCenter = normal.map(component => component * innerOffset);
    const outerCenter = normal.map(component => component * outerOffset);
    const outline = roundedRectangleOutline(halfSize, radius);
    const vertices = createRoundedSurfaceVertices(
      outerCenter,
      right,
      up,
      normal,
      halfSize,
      radius
    );

    for (let index = 0; index < outline.length; index += 1) {
      const current = outline[index];
      const next = outline[(index + 1) % outline.length];
      const edgeX = next[0] - current[0];
      const edgeY = next[1] - current[1];
      const edgeLength = Math.hypot(edgeX, edgeY) || 1;
      const outwardX = edgeY / edgeLength;
      const outwardY = -edgeX / edgeLength;
      const wallNormal = [
        right[0] * outwardX + up[0] * outwardY,
        right[1] * outwardX + up[1] * outwardY,
        right[2] * outwardX + up[2] * outwardY
      ];
      const innerCurrent = combineVectors(innerCenter, right, up, current[0], current[1]);
      const innerNext = combineVectors(innerCenter, right, up, next[0], next[1]);
      const outerCurrent = combineVectors(outerCenter, right, up, current[0], current[1]);
      const outerNext = combineVectors(outerCenter, right, up, next[0], next[1]);

      [
        innerCurrent,
        innerNext,
        outerNext,
        innerCurrent,
        outerNext,
        outerCurrent
      ].forEach(position => pushVertex(vertices, position, wallNormal, [0, 0]));
    }

    return new Float32Array(vertices);
  }

  function createTexturePanelVertices(definition, {
    offset = 1.042,
    halfSize = 0.82,
    radius = 0.082
  } = {}) {
    const [, right, up, normal] = definition;
    const center = normal.map(component => component * offset);
    return new Float32Array(
      createRoundedSurfaceVertices(center, right, up, normal, halfSize, radius)
    );
  }

  function createMesh(gl, vertices) {
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    return {
      buffer,
      count: vertices.length / 8
    };
  }

  function createTexture(gl) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255, 255])
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  function waitForImage(image) {
    if (image.complete && image.naturalWidth > 0) {
      return typeof image.decode === "function"
        ? image.decode().catch(() => undefined)
        : Promise.resolve();
    }

    return new Promise(resolve => {
      image.addEventListener("load", resolve, { once: true });
      image.addEventListener("error", resolve, { once: true });
    });
  }

  function cubicBezier(x1, y1, x2, y2) {
    const sample = (a1, a2, t) => ((1 - 3 * a2 + 3 * a1) * t + (3 * a2 - 6 * a1)) * t * t + (3 * a1) * t;
    const slope = (a1, a2, t) => 3 * (1 - 3 * a2 + 3 * a1) * t * t + 2 * (3 * a2 - 6 * a1) * t + 3 * a1;

    return progress => {
      let estimate = progress;
      for (let index = 0; index < 6; index += 1) {
        const currentSlope = slope(x1, x2, estimate);
        if (Math.abs(currentSlope) < 0.0001) break;
        estimate -= (sample(x1, x2, estimate) - progress) / currentSlope;
        estimate = clamp(estimate, 0, 1);
      }
      return sample(y1, y2, estimate);
    };
  }

  const rollEase = cubicBezier(0.30, 0.08, 0.70, 1);
  const switchEase = cubicBezier(0.22, 0.68, 0.22, 1);

  function createSolidDiceRenderer({ canvas, faceImages }) {
    if (!canvas || !Array.isArray(faceImages) || faceImages.length !== 6) return null;

    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: true,
      depth: true,
      premultipliedAlpha: true,
      powerPreference: "high-performance"
    });

    if (!gl) return null;

    const vertexSource = `
      attribute vec3 aPosition;
      attribute vec3 aNormal;
      attribute vec2 aTexCoord;
      uniform mat4 uProjection;
      uniform vec3 uRotation;
      uniform float uScale;
      varying vec3 vNormal;
      varying vec2 vTexCoord;

      vec3 rotateX(vec3 point, float angle) {
        float cosine = cos(angle);
        float sine = sin(angle);
        return vec3(point.x, point.y * cosine - point.z * sine, point.y * sine + point.z * cosine);
      }

      vec3 rotateY(vec3 point, float angle) {
        float cosine = cos(angle);
        float sine = sin(angle);
        return vec3(point.x * cosine + point.z * sine, point.y, -point.x * sine + point.z * cosine);
      }

      vec3 rotateZ(vec3 point, float angle) {
        float cosine = cos(angle);
        float sine = sin(angle);
        return vec3(point.x * cosine - point.y * sine, point.x * sine + point.y * cosine, point.z);
      }

      vec3 applyRotation(vec3 point) {
        point = rotateX(point, -uRotation.x);
        point = rotateY(point, uRotation.y);
        return rotateZ(point, -uRotation.z);
      }

      void main() {
        vec3 position = applyRotation(aPosition * uScale);
        vec3 normal = normalize(applyRotation(aNormal));
        vNormal = normal;
        vTexCoord = aTexCoord;
        gl_Position = uProjection * vec4(position + vec3(0.0, 0.0, -5.1), 1.0);
      }
    `;

    const fragmentSource = `
      precision highp float;
      uniform sampler2D uTexture;
      uniform vec4 uBaseColor;
      uniform float uTextured;
      varying vec3 vNormal;
      varying vec2 vTexCoord;

      void main() {
        vec3 normal = normalize(vNormal);
        vec3 lightDirection = normalize(vec3(-0.42, 0.72, 1.0));
        vec3 viewDirection = vec3(0.0, 0.0, 1.0);
        vec3 fillDirection = normalize(vec3(0.64, -0.18, 0.72));
        float diffuse = max(dot(normal, lightDirection), 0.0);
        float fill = max(dot(normal, fillDirection), 0.0);
        float specular = pow(
          max(dot(reflect(-lightDirection, normal), viewDirection), 0.0),
          30.0
        );
        vec4 sourceColor = uTextured > 0.5 ? texture2D(uTexture, vTexCoord) : uBaseColor;
        float light = uTextured > 0.5
          ? 0.88 + diffuse * 0.09 + fill * 0.03
          : 0.68 + diffuse * 0.25 + fill * 0.08;
        float highlight = uTextured > 0.5 ? specular * 0.012 : specular * 0.16;
        gl_FragColor = vec4(sourceColor.rgb * light + vec3(highlight), sourceColor.a);
      }
    `;

    const program = createProgram(gl, vertexSource, fragmentSource);
    const attributes = {
      position: gl.getAttribLocation(program, "aPosition"),
      normal: gl.getAttribLocation(program, "aNormal"),
      texCoord: gl.getAttribLocation(program, "aTexCoord")
    };
    const uniforms = {
      projection: gl.getUniformLocation(program, "uProjection"),
      rotation: gl.getUniformLocation(program, "uRotation"),
      scale: gl.getUniformLocation(program, "uScale"),
      texture: gl.getUniformLocation(program, "uTexture"),
      baseColor: gl.getUniformLocation(program, "uBaseColor"),
      textured: gl.getUniformLocation(program, "uTextured")
    };

    const bodyMesh = createMesh(gl, createRoundedCubeVertices());
    const panelDefinitions = [
      [[0, 0, 1], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
      [[1, 0, 0], [0, 0, -1], [0, 1, 0], [1, 0, 0]],
      [[0, 1, 0], [1, 0, 0], [0, 0, -1], [0, 1, 0]],
      [[0, 0, -1], [-1, 0, 0], [0, 1, 0], [0, 0, -1]],
      [[0, -1, 0], [1, 0, 0], [0, 0, 1], [0, -1, 0]],
      [[-1, 0, 0], [0, 0, 1], [0, 1, 0], [-1, 0, 0]]
    ];
    const plateMeshes = panelDefinitions.map(definition => ({
      frame: createMesh(gl, createPlateVertices(definition)),
      texture: createMesh(gl, createTexturePanelVertices(definition))
    }));
    const textures = faceImages.map(() => createTexture(gl));
    const anisotropy = gl.getExtension("EXT_texture_filter_anisotropic")
      || gl.getExtension("WEBKIT_EXT_texture_filter_anisotropic")
      || gl.getExtension("MOZ_EXT_texture_filter_anisotropic");

    let currentRotation = { x: -24, y: 38, z: 0 };
    let animationFrame = 0;
    let resizeFrame = 0;
    let textureRevision = 0;
    let destroyed = false;

    function bindMesh(mesh) {
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer);
      gl.enableVertexAttribArray(attributes.position);
      gl.enableVertexAttribArray(attributes.normal);
      gl.enableVertexAttribArray(attributes.texCoord);
      gl.vertexAttribPointer(attributes.position, 3, gl.FLOAT, false, 32, 0);
      gl.vertexAttribPointer(attributes.normal, 3, gl.FLOAT, false, 32, 12);
      gl.vertexAttribPointer(attributes.texCoord, 2, gl.FLOAT, false, 32, 24);
    }

    function resize() {
      const width = Math.max(1, canvas.clientWidth);
      const height = Math.max(1, canvas.clientHeight);
      const rect = canvas.getBoundingClientRect();
      const visualScale = Math.max(
        rect.width / width,
        rect.height / height,
        1
      );
      const physicalScale = (global.devicePixelRatio || 1) * visualScale;
      const pixelRatio = Math.min(4, Math.max(2, physicalScale * OUTPUT_SUPERSAMPLING));
      const targetWidth = Math.round(width * pixelRatio);
      const targetHeight = Math.round(height * pixelRatio);

      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
      }

      canvas.dataset.pixelRatio = pixelRatio.toFixed(3);
      canvas.dataset.outputWidth = String(targetWidth);
      canvas.dataset.outputHeight = String(targetHeight);

      gl.viewport(0, 0, canvas.width, canvas.height);
      return width / height;
    }

    function render() {
      if (destroyed || gl.isContextLost()) return;
      const aspect = resize();

      gl.clearColor(0, 0, 0, 0);
      gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.enable(gl.CULL_FACE);
      gl.frontFace(gl.CCW);
      gl.cullFace(gl.BACK);
      gl.disable(gl.BLEND);
      gl.useProgram(program);
      gl.uniformMatrix4fv(uniforms.projection, false, perspectiveMatrix(43.541407 * DEG_TO_RAD, aspect, 0.1, 100));
      gl.uniform3f(
        uniforms.rotation,
        currentRotation.x * DEG_TO_RAD,
        currentRotation.y * DEG_TO_RAD,
        currentRotation.z * DEG_TO_RAD
      );
      gl.uniform1f(uniforms.scale, 1.08);
      gl.uniform1i(uniforms.texture, 0);

      bindMesh(bodyMesh);
      gl.uniform1f(uniforms.textured, 0);
      gl.uniform4f(uniforms.baseColor, 0.985, 0.99, 1, 1);
      gl.drawArrays(gl.TRIANGLES, 0, bodyMesh.count);

      gl.uniform4f(uniforms.baseColor, 0.965, 0.976, 0.988, 1);
      plateMeshes.forEach(({ frame }) => {
        bindMesh(frame);
        gl.drawArrays(gl.TRIANGLES, 0, frame.count);
      });

      gl.uniform1f(uniforms.textured, 1);
      plateMeshes.forEach(({ texture }, index) => {
        bindMesh(texture);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, textures[index]);
        gl.drawArrays(gl.TRIANGLES, 0, texture.count);
      });
    }

    function uploadTexture(texture, image) {
      const sourceSize = Math.max(image.naturalWidth || 0, image.naturalHeight || 0);
      const textureSize = sourceSize > STANDARD_TEXTURE_SIZE
        ? HIGH_RES_TEXTURE_SIZE
        : STANDARD_TEXTURE_SIZE;
      const textureCanvas = document.createElement("canvas");
      textureCanvas.width = textureSize;
      textureCanvas.height = textureSize;
      const context = textureCanvas.getContext("2d", { alpha: true });
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.clearRect(0, 0, textureSize, textureSize);
      context.drawImage(image, 0, 0, textureSize, textureSize);

      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, textureCanvas);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.generateMipmap(gl.TEXTURE_2D);

      if (anisotropy) {
        const maximum = gl.getParameter(anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
        gl.texParameterf(gl.TEXTURE_2D, anisotropy.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(16, maximum));
      }
    }

    async function syncTextures() {
      const revision = ++textureRevision;
      await Promise.all(faceImages.map(waitForImage));
      if (destroyed || revision !== textureRevision || gl.isContextLost()) return;

      faceImages.forEach((image, index) => {
        if (image.naturalWidth > 0) uploadTexture(textures[index], image);
      });

      document.documentElement.classList.add("solid-dice-ready");
      render();
    }

    function setRotation(x, y, z = 0, { animate = true, duration = 3400, transition = "roll" } = {}) {
      global.cancelAnimationFrame(animationFrame);
      const target = { x, y, z };

      if (!animate || duration <= 0) {
        currentRotation = target;
        render();
        return;
      }

      const start = { ...currentRotation };
      const startTime = performance.now();
      const ease = transition === "switch" ? switchEase : rollEase;

      const drawFrame = now => {
        const progress = clamp((now - startTime) / duration, 0, 1);
        const eased = ease(progress);
        currentRotation = {
          x: start.x + (target.x - start.x) * eased,
          y: start.y + (target.y - start.y) * eased,
          z: start.z + (target.z - start.z) * eased
        };
        render();

        if (progress < 1) {
          animationFrame = global.requestAnimationFrame(drawFrame);
        } else {
          currentRotation = target;
          render();
        }
      };

      animationFrame = global.requestAnimationFrame(drawFrame);
    }

    function scheduleRender() {
      global.cancelAnimationFrame(resizeFrame);
      resizeFrame = global.requestAnimationFrame(() => {
        resizeFrame = 0;
        render();
      });
    }

    const resizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(scheduleRender)
      : null;
    resizeObserver?.observe(canvas);
    global.addEventListener("resize", scheduleRender, { passive: true });
    global.addEventListener("orientationchange", scheduleRender, { passive: true });
    global.visualViewport?.addEventListener("resize", scheduleRender, { passive: true });

    canvas.addEventListener("webglcontextlost", event => {
      event.preventDefault();
      document.documentElement.classList.remove("solid-dice-ready");
    });

    syncTextures();
    render();

    return {
      setRotation,
      syncTextures,
      render,
      destroy() {
        destroyed = true;
        global.cancelAnimationFrame(animationFrame);
        global.cancelAnimationFrame(resizeFrame);
        resizeObserver?.disconnect();
        global.removeEventListener("resize", scheduleRender);
        global.removeEventListener("orientationchange", scheduleRender);
        global.visualViewport?.removeEventListener("resize", scheduleRender);
        document.documentElement.classList.remove("solid-dice-ready");
      }
    };
  }

  global.createSolidDiceRenderer = createSolidDiceRenderer;
})(window);
