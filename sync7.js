
var sync7 = {}

sync7.create = function () {
    return {
        versions : {
            'root' : { to_parents : {}, from_kids : {} }
        },
        waiting_versions : {},
        temp_versions : {},
        real_leaves : ['root'],
        leaf : 'root',
        text : ''
    }
}

sync7.commit = function (s7, s) {
    if (s == s7.text) { return }
    
    var cs = s7.temp_versions
    s7.temp_versions = {}

    var id = guid()
    var to_parents = {}
    s7.versions[s7.leaf].from_kids[id] = to_parents[s7.leaf] = sync7_diff(s, s7.text)
    
    var a_regions = []
    var offset = 0
    to_parents[s7.leaf].forEach((x, i) => {
        if (Array.isArray(x)) {
            a_regions.push([offset, x[0].length, true, i, null, -1])
            offset += x[0].length
        } else {
            a_regions.push([offset, x, true, i, null, -1])
            offset += x
        }
    })
    
    s7.versions[id] = cs[id] = {
        to_parents : to_parents,
        from_kids : {},
        
        merge_info : {
            a_text : s,
            b_text : '',
            a_regions : a_regions,
            b_regions : []
        }
    }
    s7.leaf = id
    s7.real_leaves = [id]
    
    s7.text = s
    return cs
}

sync7.merge = function (s7, cs, cursors, custom_merge_func) {
    if (!cursors) cursors = {}
    if (!custom_merge_func) custom_merge_func = default_custom_merge_func
    
    each(cs, function (c, id) {
        each(c.to_parents, function (d, p) {
            if (s7.waiting_versions[p]) {
                s7.waiting_versions[p].from_kids[id] = d
            }
        })
    })
    each(s7.waiting_versions, function (c, id) {
        each(c.to_parents, function (d, p) {
            if (cs[p]) {
                cs[p].from_kids[id] = d
            }
        })
    })
    
    var cant_add_these = {}
    function find_version(id) {
        return s7.versions[id] || cs[id] || s7.waiting_versions[id]
    }
    function mark_this_and_kids_as_unaddable(c, id) {
        if (!cant_add_these[id]) {
            cant_add_these[id] = true
            each(c.from_kids, function (d, kid) {
                var kidc = find_version(kid)
                if (kidc)
                    mark_this_and_kids_as_unaddable(kidc, kid)
            })
        }
    }
    function process_version(c, id) {
        var missing_parent = false
        each(c.to_parents, function (d, p) {
            if (!find_version(p)) {
                missing_parent = true
                return false
            }
        })
        if (missing_parent)
            mark_this_and_kids_as_unaddable(c, id)
    }        
    each(cs, process_version)
    each(s7.waiting_versions, process_version)
    
    if (Object.keys(cs).length + Object.keys(s7.waiting_versions).length - Object.keys(cant_add_these).length <= 0) {
        Object.assign(s7.waiting_versions, cs)
        return cursors
    }        
    
    var projected_cursors = map(cursors, function (cursor) {
        var node = s7.leaf
        while (s7.temp_versions[node]) {
            var old_node = node
            each(s7.versions[node].to_parents, function (d, p) {
                var offset = 0
                var poffset = 0
                each(d, function (d) {
                    if (typeof(d) == 'number') {
                        if (cursor <= offset + d) {
                            cursor = cursor - offset + poffset
                            node = p
                            return false
                        }
                        offset += d
                        poffset += d
                    } else {
                        offset += d[0].length
                        poffset += d[1].length
                    }
                })
                if (old_node != node) return false
            })
            if (old_node == node) throw 'failed to project cursor up'
        }
        return [cursor, node]
    })
    
    function process_version2(c, id) {
        if (cant_add_these[id]) {
            if (cs[id])
                s7.waiting_versions[id] = c
        } else {
            s7.versions[id] = c
            if (s7.waiting_versions[id])
                delete s7.waiting_versions[id]
            each(c.to_parents, function (d, p) {
                if (s7.versions[p]) {
                    s7.versions[p].from_kids[id] = d
                }
            })
        }
    }
    each(cs, process_version2)
    each(s7.waiting_versions, process_version2)        

    s7.real_leaves = sync7_get_leaves(s7.versions, s7.temp_versions)
    var leaves = Object.keys(s7.real_leaves).sort()
    
    var texts = {}
    each(leaves, function (leaf) {
        texts[leaf] = sync7_get_text(s7, leaf)
    })

    each(s7.temp_versions, function (c, k) {
        each(c.to_parents, function (d, p) {
            if (!s7.temp_versions[p]) {
                delete s7.versions[p].from_kids[k]
            }
        })
        delete s7.versions[k]
    })
    s7.temp_versions = {}
    
    var prev_merge_node = leaves[0]
    var ancestors = sync7_get_ancestors(s7, prev_merge_node)
    for (var i = 1; i < leaves.length; i++) {
        var leaf = leaves[i]
        var i_ancestors = sync7_get_ancestors(s7, leaf)
        var CAs = sync7_intersection(ancestors, i_ancestors)
        var LCAs = sync7_get_leaves(CAs)
        each(i_ancestors, function (v, k) {
            ancestors[k] = v
        })
        
        function get_nodes_on_path_to_LCAs(node) {
            var agg = {}
            function helper(x) {
                var hit_LCA = LCAs[x]
                if (!CAs[x]) {
                    each(s7.versions[x].to_parents, function (d, p) {
                        hit_LCA = helper(p) || hit_LCA
                    })
                }
                if (hit_LCA) {
                    agg[x] = true
                    return true
                }
            }
            helper(node)
            return agg
        }

        function calc_dividers_and_such_for_node(node, nodes_on_path_to_LCAs, dividers, untouched_regions_for_node) {
            untouched_regions_for_node[node] = [[0, texts[node].length, 0]]
            function helper(node) {
                if (untouched_regions_for_node[node]) return untouched_regions_for_node[node]
                var pur = {}
                each(s7.versions[node].from_kids, function (d, k) {
                    if (!nodes_on_path_to_LCAs[k]) { return }
                    var untouched = helper(k)
                    
                    var ui = 0
                    var uo = 0
                    var offset = 0
                    var poffset = 0
                    each(d, function (r) {
                        var end_point = offset + ((typeof(r) == 'number') ? r : r[0].length)
                        while (untouched[ui] && end_point >= untouched[ui][2] + untouched[ui][1]) {
                            if (typeof(r) == 'number') {
                                var x = untouched[ui][2] + uo - offset + poffset
                                pur[x] = [untouched[ui][0] + uo, untouched[ui][1] - uo, x]
                            }
                            ui++
                            uo = 0
                        }
                        if (!untouched[ui]) { return false }
                        if (end_point > untouched[ui][2] + uo) {
                            if (typeof(r) == 'number') {
                                var x = untouched[ui][2] + uo - offset + poffset
                                pur[x] = [untouched[ui][0] + uo, end_point - (untouched[ui][2] + uo), x]
                            }
                            uo = end_point - untouched[ui][2]
                            dividers[untouched[ui][0] + uo] = untouched[ui][0] + uo
                        }
                        offset = end_point
                        poffset += (typeof(r) == 'number') ? r : r[1].length
                    })
                })
                return untouched_regions_for_node[node] = Object.values(pur).sort(function (a, b) { return a[2] - b[2] })
            }
            each(LCAs, function (_, lca) { helper(lca) })
        }

        var prev_nodes_on_path_to_LCAs = get_nodes_on_path_to_LCAs(prev_merge_node)
        var prev_dividers = {}
        var prev_untouched_regions_for_node = {}
        calc_dividers_and_such_for_node(prev_merge_node, prev_nodes_on_path_to_LCAs, prev_dividers, prev_untouched_regions_for_node)

        var leaf_nodes_on_path_to_LCAs = get_nodes_on_path_to_LCAs(leaf)
        var leaf_dividers = {}
        var leaf_untouched_regions_for_node = {}
        calc_dividers_and_such_for_node(leaf, leaf_nodes_on_path_to_LCAs, leaf_dividers, leaf_untouched_regions_for_node)
        
        each(LCAs, function (_, lca) {
            function do_one_against_the_other(a, b, dividers) {
                var bb, bi = 0
                each(a, function (aa) {
                    while ((bb = b[bi]) && (bb[2] + bb[1] <= aa[2])) bi++
                    if (bb && bb[2] < aa[2]) {
                        var x = aa[2] - bb[2] + bb[0]
                        dividers[x] = x
                    }
                    while ((bb = b[bi]) && (bb[2] + bb[1] <= aa[2] + aa[1])) bi++
                    if (bb && bb[2] < aa[2] + aa[1]) {
                        var x = aa[2] + aa[1] - bb[2] + bb[0]
                        dividers[x] = x
                    }
                })
            }
            
            var a = prev_untouched_regions_for_node[lca]
            var b = leaf_untouched_regions_for_node[lca]
            do_one_against_the_other(a, b, leaf_dividers)
            do_one_against_the_other(b, a, prev_dividers)
        })
        
        function calc_endpoints(dividers, node) {
            var endpoints = []
            endpoints.push([0, 0, 0])
            each(Object.values(dividers).sort(function (a, b) { return a - b }), function (offset) {
                endpoints.push([offset, 1, offset])
                endpoints.push([offset, 0, offset])
            })
            endpoints.push([texts[node].length, 1, texts[node].length])
            
            return endpoints
        }
        
        var prev_endpoints = calc_endpoints(prev_dividers, prev_merge_node)
        var leaf_endpoints = calc_endpoints(leaf_dividers, leaf)

        function project_endpoints_to_LCAs(endpoints, node, nodes_on_path_to_LCAs) {
            var endpoints_for_node = {}
            endpoints_for_node[node] = endpoints

            function helper(node) {
                if (endpoints_for_node[node]) return endpoints_for_node[node]
                var agg = {}
                function add_to_agg(endpoint, projected_pos) {
                    var key = '[' + endpoint[0] + ',' + endpoint[1] + ']'
                    if (endpoint[1] == 0)
                        agg[key] = Math.min(agg[key] || Infinity, projected_pos)
                    else
                        agg[key] = Math.max(agg[key] || -Infinity, projected_pos)
                }
                each(s7.versions[node].from_kids, function (d, k) {
                    if (!nodes_on_path_to_LCAs[k]) { return }
                    
                    var endpoints = helper(k)
                    var ei = 0
                    
                    var offset = 0
                    var poffset = 0
                    each(d, function (d) {
                        var end = offset + ((typeof(d) == 'number') ? d : d[0].length)
                        while (endpoints[ei] && (endpoints[ei][2] < end || (endpoints[ei][1] == 1 && endpoints[ei][2] <= end))) {
                            if (typeof(d) == 'number') {
                                add_to_agg(endpoints[ei], endpoints[ei][2] - offset + poffset)
                            } else if (endpoints[ei][1] == 0) {
                                add_to_agg(endpoints[ei], poffset)
                            } else {
                                add_to_agg(endpoints[ei], poffset + d[1].length)
                            }
                            ei++
                        }
                        offset = end
                        poffset += (typeof(d) == 'number') ? d : d[1].length
                    })
                    while (endpoints[ei]) {
                        add_to_agg(endpoints[ei], poffset)
                        ei++
                    }
                })
                
                var endpoints = []
                each(agg, function (v, k) {
                    var kk = eval(k)
                    endpoints.push([kk[0], kk[1], v])
                })
                
                return endpoints_for_node[node] = endpoints.sort(function (a, b) {
                    if (a[2] != b[2])
                        return a[2] - b[2]
                    return b[1] - a[1]
                })
            }

            var regions_for_node = {}

            var lookup_by_begin = {}
            var lookup_by_end = {}
            var base_regions = []
            regions_for_node[node] = base_regions
            for (var i = 0; i < endpoints.length; i += 2) {
                var e0 = endpoints[i][0]
                var e1 = endpoints[i + 1][0]
                base_regions.push([e0, e1 - e0])
                lookup_by_begin[e0] = base_regions.length - 1
                lookup_by_end[e1] = base_regions.length - 1
            }
            
            each(LCAs, function (_, lca) {
                var endpoints = helper(lca)
                var regions = []
                regions_for_node[lca] = regions
                each(endpoints, function (e) {
                    if (e[1] == 0) {
                        var i = lookup_by_begin[e[0]];
                        (regions[i] = regions[i] || [])[0] = e[2]
                    } else {
                        var i = lookup_by_end[e[0]];
                        (regions[i] = regions[i] || [])[1] = e[2]
                    }
                })
                each(regions, function (r) {
                    r[1] = r[1] - r[0]
                })
            })

            return regions_for_node
        }
        
        var prev_regions_per_node = project_endpoints_to_LCAs(prev_endpoints, prev_merge_node, prev_nodes_on_path_to_LCAs)
        var leaf_regions_per_node = project_endpoints_to_LCAs(leaf_endpoints, leaf, leaf_nodes_on_path_to_LCAs)
        
        var prev_regions = prev_regions_per_node[prev_merge_node]
        var leaf_regions = leaf_regions_per_node[leaf]

        var prev_untouched_regions_for_LCA_by_position = {}
        var leaf_untouched_regions_for_LCA_by_position = {}

        each(LCAs, function (_, lca) {
            function process(base, regions, untouched, _by_position) {
                _by_position[lca] = {}
                var ri = 0
                var r
                each(untouched, function (u) {
                    while ((r = regions[ri]) && r[0] + r[1] <= u[2]) { ri++ }
                    while ((r = regions[ri]) && r[0] < u[2] + u[1]) {
                        _by_position[lca][r[0]] = ri
                        base[ri][2] = true
                        r[2] = true
                        ri++
                    }
                })
            }
            process(prev_regions_per_node[prev_merge_node], prev_regions_per_node[lca], prev_untouched_regions_for_node[lca], prev_untouched_regions_for_LCA_by_position)
            process(leaf_regions_per_node[leaf], leaf_regions_per_node[lca], leaf_untouched_regions_for_node[lca], leaf_untouched_regions_for_LCA_by_position)
        })

        function mark_deletes_and_more(regions_for_node, node, other_untouched_for_LCA_by_position) {
            each(regions_for_node[node], function (r, ri) {
                r[4] = r[5] = -1 // <-- the "more"
                if (r[2]) {
                    r[3] = -1
                    each(LCAs, function (_, lca) {
                        var rr = regions_for_node[lca][ri]
                        var other_ri = other_untouched_for_LCA_by_position[lca][rr[0]]
                        if (rr[2] && (typeof(other_ri) == 'number')) {
                            r[3] = other_ri
                            return false
                        }
                    })
                }
            })
        }
        mark_deletes_and_more(prev_regions_per_node, prev_merge_node, leaf_untouched_regions_for_LCA_by_position)
        mark_deletes_and_more(leaf_regions_per_node, leaf, prev_untouched_regions_for_LCA_by_position)

        function is_definitely_before(a_regions, a_node, ai, b_regions, b_node, bi) {
            var a_before_b = false
            var b_before_a = false
            each(LCAs, function (_, lca) {
                var ar = a_regions[lca][ai]
                var br = b_regions[lca][bi]
                
                if ((ar[1] || br[1]) && (ar[0] + ar[1] <= br[0]))
                    a_before_b = true
                if ((!ar[1] && !br[1]) && (ar[0] < br[0]))
                    a_before_b = true
                    
                if ((ar[1] || br[1]) && (br[0] + br[1] <= ar[0]))
                    b_before_a = true
                if ((!ar[1] && !br[1]) && (br[0] < ar[0]))
                    b_before_a = true
            })
            return a_before_b && !b_before_a
        }
        
        function calc_known_orderings(a_regions, a_node, b_regions, b_node) {
            var bi = 0
            each(a_regions[a_node], function (ar, ai) {
                for ( ; bi < b_regions[b_node].length; bi++) {
                    if (is_definitely_before(a_regions, a_node, ai, b_regions, b_node, bi)) {
                        ar[4] = bi
                        b_regions[b_node][bi][5] = ai
                        return
                    }
                }
            })
        }
        calc_known_orderings(prev_regions_per_node, prev_merge_node, leaf_regions_per_node, leaf)
        calc_known_orderings(leaf_regions_per_node, leaf, prev_regions_per_node, prev_merge_node)

        var m = custom_merge_func(s7, prev_merge_node, leaf, texts[prev_merge_node], texts[leaf], prev_regions, leaf_regions)
        
        var id = guid()
        var to_parents = {}
        s7.versions[prev_merge_node].from_kids[id] = to_parents[prev_merge_node] = m.to_a
        s7.versions[leaf].from_kids[id] = to_parents[leaf] = m.to_b
        s7.versions[id] = s7.temp_versions[id] = {
            to_parents : to_parents,
            from_kids : {},
            
            merge_info : {
                a_text : texts[prev_merge_node],
                b_text : texts[leaf],
                a_regions : prev_regions,
                b_regions : leaf_regions
            }
        }
        
        prev_merge_node = id
        texts[prev_merge_node] = m.text
    }

    s7.leaf = prev_merge_node
    s7.text = texts[prev_merge_node]
    
    return map(projected_cursors, function (cursor) {
        while (cursor[1] != s7.leaf) {
            var old_node = cursor[1]
            var kids = s7.versions[cursor[1]].from_kids
            var kid = Object.keys(kids)[0]
            var d = kids[kid]

            var offset = 0
            var poffset = 0
            each(d, function (d) {
                if (typeof(d) == 'number') {
                    if (cursor[0] <= poffset + d) {
                        cursor[0] = cursor[0] - poffset + offset
                        cursor[1] = kid
                        return false
                    }
                    offset += d
                    poffset += d
                } else {
                    if (cursor[0] <= poffset + d[1].length) {
                        cursor[0] = offset
                        cursor[1] = kid
                        return false
                    }
                    offset += d[0].length
                    poffset += d[1].length
                }
            })
            if (cursor[1] == old_node) {
                cursor[0] = offset
                cursor[1] = kid
            }
        }
        return cursor[0]
    })
}

function default_custom_merge_func(s7, a, b, a_text, b_text, a_regions, b_regions) {
    // regions be like [pos, len, untouched?, index in other region array of this untouched or -1 if not present, index of first region in other array that this region is definitely before, index of last region in other array that this region is definitely after]
    
    // console.log('HI!!')
    // console.log(a)
    // console.log(b)
    // console.log(a_text)
    // console.log(b_text)
    // console.log(a_regions)
    // console.log(b_regions)

    var text = []
    var a_diff = []
    var b_diff = []
    var on_a = true
    var ai = 0
    var bi = 0
    while (true) {
        var aa = a_regions[ai]
        var bb = b_regions[bi]
        if (!aa && !bb) break
        if (!aa) on_a = false
        if (!bb) on_a = true
        
        var ci = on_a ? ai : bi
        var di = on_a ? bi : ai
        var cc = on_a ? aa : bb
        var dd = on_a ? bb : aa
        var c_text = on_a ? a_text : b_text
        var d_text = on_a ? b_text : a_text
        var c_diff = on_a ? a_diff : b_diff
        var d_diff = on_a ? b_diff : a_diff

        if (cc[5] < di) {
            var t = c_text.substr(cc[0], cc[1])
            if (cc[2]) {
                if (cc[3] < di) {
                    c_diff.push(['', t])
                } else if (cc[3] == di) {
                    text.push(t)
                    sync7_push_eq(c_diff, cc[1])
                    sync7_push_eq(d_diff, cc[1])
                    if (on_a) { bi++ } else { ai++ }
                } else {
                    text.push(t)
                    sync7_push_eq(c_diff, cc[1])
                    d_diff.push([t, ''])
                }
            } else {
                text.push(t)
                sync7_push_eq(c_diff, cc[1])
                d_diff.push([t, ''])
            }
            if (on_a) { ai++ } else { bi++ }
        } else if (dd && dd[5] < ci) {
            on_a = !on_a
        } else {
            throw 'failure'
        }
    }

    // console.log('HI!!!!!!')
    // console.log(text)
    // console.log(a_diff)
    // console.log(b_diff)

    return {
        text : text.join(''),
        to_a : a_diff,
        to_b : b_diff
    }
}

function sync7_diff_merge_trans(a, b, a_factor, b_factor) {
    var ret = []
    var a_i = 0
    var b_i = 0
    var a_offset = 0
    var b_offset = 0
    var a_dumped_load = false
    var b_dumped_load = false
    function neg_idx(i) {
        return i == 0 ? 1 : 0
    }
    function a_idx(i) {
        return a_factor == -1 ? neg_idx(i) : i
    }
    function b_idx(i) {
        return b_factor == -1 ? neg_idx(i) : i
    }
    while (a_i < a.length && b_i < b.length) {
        var da = a[a_i]
        var db = b[b_i]
        if (typeof(da) == 'number' && typeof(db) == 'number') {
            var a_len = da - a_offset
            var b_len = db - b_offset
            sync7_push_eq(ret, Math.min(a_len, b_len))
        } else if (typeof(da) == 'number') {
            var a_len = da - a_offset
            var b_len = db[b_idx(0)].length - b_offset
            sync7_push_rep(ret, db[b_idx(0)].substr(b_offset, Math.min(a_len, b_len)), !b_dumped_load ? db[b_idx(1)] : '')
            b_dumped_load = true
        } else if (typeof(db) == 'number') {
            var a_len = da[a_idx(1)].length - a_offset
            var b_len = db - b_offset
            sync7_push_rep(ret, !a_dumped_load ? da[a_idx(0)] : '', da[a_idx(1)].substr(a_offset, Math.min(a_len, b_len)))
            a_dumped_load = true
        } else {
            var a_len = da[a_idx(1)].length - a_offset
            var b_len = db[b_idx(0)].length - b_offset
            sync7_push_rep(ret, !a_dumped_load ? da[a_idx(0)] : '', !b_dumped_load ? db[b_idx(1)] : '')
            a_dumped_load = b_dumped_load = true
        }
        if (a_len > b_len) {
            a_offset += b_len
        } else {
            a_i++
            a_offset = 0
            a_dumped_load = false
        }
        if (a_len < b_len) {
            b_offset += a_len
        } else {
            b_i++
            b_offset = 0
            b_dumped_load = false
        }
    }
    while (a_i < a.length) {
        var da = a[a_i]
        if (typeof(da) == 'number') {
            sync7_push_eq(ret, da)
        } else {
            sync7_push_rep(ret, !a_dumped_load ? da[a_idx(0)] : '', da[a_idx(1)].substr(a_offset))
        }
        a_i++
        a_offset = 0
        a_dumped_load = false
    }
    while (b_i < b.length) {
        var db = b[b_i]
        if (typeof(db) == 'number') {
            sync7_push_eq(ret, db)
        } else {
            sync7_push_rep(ret, db[b_idx(0)].substr(b_offset), !b_dumped_load ? db[b_idx(1)] : '')
        }
        b_i++
        b_offset = 0
        b_dumped_load = false
    }
    return ret
}



function sync7_merge_path_up(s7, from, path) {
    var diff = []
    var prev = from
    each(path, function (next) {
        diff = sync7_diff_merge_trans(diff, s7.versions[prev].to_parents[next])
        prev = next
    })
    return diff
}


function sync7_get_text(s7, id) {
    var ls = sync7_get_leaves(sync7_intersection(sync7_get_ancestors(s7, s7.leaf, true), sync7_get_ancestors(s7, id, true)))
    var lca = Object.keys(ls)[0]
    var leaf_to_lca = sync7_get_path_to_ancestor(s7, s7.leaf, lca)
    var lca_to_id = sync7_get_path_to_ancestor(s7, id, lca).reverse()
    if (lca_to_id.length > 0) {
        lca_to_id.shift()
        lca_to_id.push(id)
    }
    
    var diff = sync7_merge_path_up(s7, s7.leaf, leaf_to_lca)
    var prev = lca
    each(lca_to_id, function (next) {
        diff = sync7_diff_merge_trans(diff, s7.versions[next].to_parents[prev], 1, -1)
        prev = next
    })
    
    return sync7_diff_apply(s7.text, diff)
}
    
function sync7_get_leaves(versions, ignore) {
    if (!ignore) ignore = {}
    var leaves = {}
    each(versions, function (_, id) {
        if (ignore[id]) { return }
        leaves[id] = true
    })
    each(versions, function (c, id) {
        if (ignore[id]) { return }
        each(c.to_parents, function (_, p) {
            delete leaves[p]
        })
    })
    return leaves
}

function sync7_get_ancestors(s7, id_or_set, include_self) {
    var frontier = null
    var ancestors = {}
    if (typeof(id_or_set) == 'object') {
        frontier = Object.keys(id_or_set)
        if (include_self) each(id_or_set, function (_, id) {
            ancestors[id] = s7.versions[id]
        })
    } else {
        frontier = [id_or_set]
        if (include_self) ancestors[id_or_set] = s7.versions[id_or_set]
    }
    while (frontier.length > 0) {
        var next = frontier.shift()
        each(s7.versions[next].to_parents, function (_, p) {
            if (!ancestors[p]) {
                ancestors[p] = s7.versions[p]
                frontier.push(p)
            }
        })
    }
    return ancestors
}

function sync7_get_path_to_ancestor(s7, a, b) {
    if (a == b) { return [] }
    var frontier = [a]
    var backs = {}
    while (frontier.length > 0) {
        var next = frontier.shift()
        if (next == b) {
            var path = []
            while (next && (next != a)) {
                path.unshift(next)
                next = backs[next]
            }
            return path
        }
        each(s7.versions[next].to_parents, function (_, p) {
            if (!backs[p]) {
                backs[p] = next
                frontier.push(p)
            }
        })
    }
    throw 'no path found from ' + a + ' to ' + b
}

function sync7_intersection(a, b) {
    var common = {}
    each(a, function (_, x) {
        if (b[x]) {
            common[x] = a[x]
        }
    })
    return common
}

function sync7_diff(a, b) {
    var ret = []
    var d = diff_main(a, b)
    for (var i = 0; i < d.length; i++) {
        var top = ret[ret.length - 1]
        if (d[i][0] == 0) {
            ret.push(d[i][1].length)
        } else if (d[i][0] == 1) {
            if (top && (typeof(top) != 'number'))
                top[1] += d[i][1]
            else
                ret.push(['', d[i][1]])
        } else {
            if (top && (typeof(top) != 'number'))
                top[0] += d[i][1]
            else
                ret.push([d[i][1], ''])
        }
    }
    return ret
}

function sync7_push_eq(diffs, size) {
    if (typeof(diffs[diffs.length - 1]) == 'number') {
        diffs[diffs.length - 1] += size
    } else diffs.push(size)
}

function sync7_push_rep(diffs, del, ins) {
    if (del.length == 0 && ins.length == 0) { return }
    if (diffs.length > 0) {
        var top = diffs[diffs.length - 1]
        if (typeof(top) != 'number') {
            top[0] += del
            top[1] += ins
            return
        }
    }
    diffs.push([del, ins])
}

function sync7_diff_apply(s, diff) {
    var offset = 0
    var texts = []
    each(diff, function (d) {
        if (typeof(d) == 'number') {
            texts.push(s.substr(offset, d))
            offset += d
        } else {
            texts.push(d[1])
            offset += d[0].length
        }
    })
    texts.push(s.substr(offset))
    return texts.join('')
}

function guid() {
    var x = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
    var s = []
    for (var i = 0; i < 15; i++) {
        s.push(x[Math.floor(Math.random() * x.length)])
    }
    return s.join('')
}

function each(o, cb) {
    if (o instanceof Array) {
        for (var i = 0; i < o.length; i++) {
            if (cb(o[i], i, o) == false)
                return false
        }
    } else {
        for (var k in o) {
            if (o.hasOwnProperty(k)) {
                if (cb(o[k], k, o) == false)
                    return false
            }
        }
    }
    return true
}

function map(o, func) {
    if (o instanceof Array) {
        var accum = []
        for (var i = 0; i < o.length; i++)
            accum[i] = func(o[i], i, o)
        return accum
    } else {
        var accum = {}
        for (var k in o)
            if (o.hasOwnProperty(k))
                accum[k] = func(o[k], k, o)
        return accum
    }
}
