'use strict';

const express = require('express');

const { verifyCsrfToken } = require('../middleware/csrf');
const { validateProjectInput } = require('../lib/projectValidation');

const EMPTY_PROJECT = {
  name: '',
  liveUrl: '',
  stagingUrl: '',
  basicAuthUsername: '',
  hasPassword: false,
};

function renderNotFound(res) {
  res.status(404).render('error', {
    title: 'Not found',
    message: "That project doesn't exist, or has already been deleted.",
  });
}

/**
 * Builds the project CRUD router. All state-changing routes (POST
 * create/edit/delete) go through verifyCsrfToken — see requirement 10.
 * Cache-Control: no-store and the bfcache pageshow guard are NOT wired
 * up here: they're already generic to every authenticated route (see
 * app.js's noStore middleware and views/partials/head.ejs), which is
 * exactly the point — a route mounted after requireAuth gets both for
 * free rather than needing to remember them.
 */
function createProjectsRouter({ urlHelper, repository }) {
  const router = express.Router();

  router.get('/projects', (req, res, next) => {
    try {
      const projects = repository.listProjects();
      res.render('projects/list', { projects });
    } catch (err) {
      next(err);
    }
  });

  router.get('/projects/new', (req, res) => {
    res.render('projects/form', { project: EMPTY_PROJECT, errors: {}, isEdit: false });
  });

  router.post('/projects', verifyCsrfToken, async (req, res, next) => {
    try {
      const { errors, values } = await validateProjectInput(req.body, { isEdit: false });

      if (Object.keys(errors).length > 0) {
        res.status(400).render('projects/form', { project: values, errors, isEdit: false });
        return;
      }

      repository.createProject(values);
      res.redirect(302, urlHelper('/projects'));
    } catch (err) {
      next(err);
    }
  });

  router.get('/projects/:id/edit', (req, res, next) => {
    try {
      const project = repository.getProjectForEdit(req.params.id);
      if (!project) {
        renderNotFound(res);
        return;
      }
      res.render('projects/form', { project, errors: {}, isEdit: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/projects/:id', verifyCsrfToken, async (req, res, next) => {
    try {
      const existing = repository.getProjectForEdit(req.params.id);
      if (!existing) {
        renderNotFound(res);
        return;
      }

      const { errors, values } = await validateProjectInput(req.body, { isEdit: true });

      if (Object.keys(errors).length > 0) {
        res.status(400).render('projects/form', {
          project: { ...values, id: req.params.id, hasPassword: existing.hasPassword },
          errors,
          isEdit: true,
        });
        return;
      }

      repository.updateProject(req.params.id, values);
      res.redirect(302, urlHelper('/projects'));
    } catch (err) {
      next(err);
    }
  });

  router.get('/projects/:id/delete', (req, res, next) => {
    try {
      const project = repository.getProjectForEdit(req.params.id);
      if (!project) {
        renderNotFound(res);
        return;
      }
      res.render('projects/delete-confirm', { project });
    } catch (err) {
      next(err);
    }
  });

  router.post('/projects/:id/delete', verifyCsrfToken, (req, res, next) => {
    try {
      repository.deleteProject(req.params.id);
      res.redirect(302, urlHelper('/projects'));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createProjectsRouter };
